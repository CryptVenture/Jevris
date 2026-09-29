/**
 * `jevris task reconcile <taskId> --applied|--abandoned`: settles an owned worker's effect that
 * the kill switch held (GOV-03, US40), through D's `task.reconcile` sidecar op. It is CLI-only
 * (submit scope; no MCP tool or hook can reach it), and a person confirms it: after it, the
 * task moves from blocked to ready.
 */
import { userInfo } from 'node:os';
import { COMMAND_EXIT_CODES, surfacePayloadContract, type SurfacePayloads } from '@jevris/contracts';
import { defaultPorts } from './public/ports.js';
import { authorized, contextFor, parse, type VerifyAdminOptions } from './verify-admin.js';
import { homeRefusal } from './public/home-guard.js';

type Write = (text: string) => void;

export const TASK_HELP = `Usage: jevris task reconcile <task-id> --applied|--abandoned [--yes] [--json]
       jevris task cancel <task-id> [--duplicate-of <task-id>] [--yes] [--json]
       jevris task revert-duplicate <task-id> [--yes] [--json]

cancel stops an owned task: its lease is released and the task is cancelled. Its worktree is
kept, and a worktree with uncommitted or unknown changes is never deleted. Only the CLI can
cancel; no model tool can. It needs --yes or a y/N answer on a terminal. With --duplicate-of,
you accept duplicate-work advice (jevris advise C28): the task is cancelled as a duplicate of
the one you keep, and the cancellation is recorded as such.

revert-duplicate tells Jevris that a duplicate cancellation was wrong. It is recorded as a false
cancellation, which the duplicate-work advice learns from; re-plan the work yourself. Only a
task cancelled with --duplicate-of can be reverted.

reconcile:

Settles an owned worker's effect that the kill switch held while it was stopped. Say whether
the effect was applied (the worker's change is in place) or abandoned (it is not, and will not
be). The task then moves from blocked to ready. Run it after jevris kill-switch clear; while
the switch is stopped the sidecar refuses it. Only the CLI can reconcile; no model tool can.

Options:
  --applied           The held effect took place
  --abandoned         The held effect did not take place and is dropped
  --yes               Confirm without the terminal question
  --home <dir>        Jevris home (default: JEVRIS_HOME, else your home directory)
  --workspace <dir>   Workspace (default: the repository containing the current directory)
  --json              Print one JSON result line

Exit codes: 0 reconciled or cancelled; 1 nothing was reconciled or cancelled (nothing held,
unknown task, the kill switch is stopped, or the sidecar is not running); 2 usage error or not
confirmed.

Examples:
  jevris task reconcile T1 --applied
  jevris task reconcile T1 --abandoned --yes --json
  jevris task cancel T1
  jevris task cancel T1 --yes --json
  jevris task cancel T2 --duplicate-of T1 --yes
  jevris task revert-duplicate T2 --yes`;

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/;
const REASONS = new Set(['RECONCILED', 'NOT_HELD', 'UNKNOWN_TASK', 'STORE_UNAVAILABLE', 'REFUSED', 'KILL_SWITCH']);

export interface TaskReconcileResult {
  readonly reconciled: boolean;
  readonly reasonCode: string;
  readonly taskId: string;
  readonly operationId: string | null;
  readonly effectState: 'acknowledged' | 'abandoned' | null;
  readonly taskState: string | null;
  readonly auditSeq: number | null;
  readonly held: number;
}

const shortOrNull = (value: unknown, pattern: RegExp): value is string | null => value === null || (typeof value === 'string' && pattern.test(value));

/** Checks the sidecar's answer against D's shape; null when it does not match. */
export function checkReconcileResult(raw: unknown, taskId: string): TaskReconcileResult | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as { [key: string]: unknown };
  const { reconciled, reasonCode, operationId, effectState, taskState, auditSeq, held } = r;
  if (typeof reconciled !== 'boolean' || typeof reasonCode !== 'string' || !REASONS.has(reasonCode) || r['taskId'] !== taskId) return null;
  if (!shortOrNull(operationId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/) || !shortOrNull(taskState, /^[a-z][a-z-]{0,31}$/)) return null;
  if (effectState !== null && effectState !== 'acknowledged' && effectState !== 'abandoned') return null;
  if (auditSeq !== null && (typeof auditSeq !== 'number' || !Number.isSafeInteger(auditSeq) || auditSeq < 0)) return null;
  if (typeof held !== 'number' || !Number.isSafeInteger(held) || held < 0) return null;
  if (reconciled !== (reasonCode === 'RECONCILED')) return null;
  return { reconciled, reasonCode, taskId, operationId, effectState, taskState, auditSeq, held };
}

function render(result: TaskReconcileResult, resolution: 'applied' | 'abandoned'): string {
  const still = result.held > 0 ? ` ${result.held} other held effect(s) remain; see jevris status.` : '';
  switch (result.reasonCode) {
    case 'RECONCILED':
      return `Reconciled owned effect ${result.operationId ?? 'unknown'} as ${resolution}; task ${result.taskId} is ${result.taskState ?? 'unknown'}.${still}`;
    case 'NOT_HELD':
      return `Nothing to reconcile for ${result.taskId}.${still}`;
    case 'UNKNOWN_TASK':
      return `There is no task ${result.taskId} in this workspace; nothing was reconciled.`;
    case 'KILL_SWITCH':
      return 'The kill switch is stopped, so nothing was reconciled. Clear it first with jevris kill-switch clear.';
    case 'STORE_UNAVAILABLE':
      return 'The Jevris store is not available, so nothing was reconciled. Run jevris doctor.';
    default:
      return `Nothing was reconciled (${result.reasonCode}).`;
  }
}

function actorName(): string | undefined {
  try {
    const name = userInfo().username;
    return ACTOR.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

/** Runs `jevris task <subcommand> ...` (argv after `task`). */
export async function runTaskCommand(argv: readonly string[], write: Write, options: VerifyAdminOptions = {}): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    write(`${TASK_HELP}\n`);
    return argv.length === 0 ? COMMAND_EXIT_CODES.usage : COMMAND_EXIT_CODES.ok;
  }
  if (argv[0] === 'cancel') return runTaskCancel(argv.slice(1), write, options);
  if (argv[0] === 'revert-duplicate') return runTaskRevertDuplicate(argv.slice(1), write, options);
  const parsed = parse(argv.slice(1), ['--home', '--workspace'], ['--applied', '--abandoned', '--yes', '--json']);
  const json = typeof parsed !== 'string' && parsed.flags.has('--json');
  const usage = (message: string): number => {
    write(json ? `${JSON.stringify({ error: { code: 'USAGE', message } })}\n` : `${message}\nRun jevris help task for usage.\n`);
    return COMMAND_EXIT_CODES.usage;
  };
  if (argv[0] !== 'reconcile') return usage(`Unknown task subcommand ${String(argv[0]).slice(0, 40)}. Use jevris task reconcile, cancel or revert-duplicate.`);
  if (typeof parsed === 'string') return usage(parsed);
  const taskId = parsed.positionals[0];
  if (parsed.positionals.length !== 1 || taskId === undefined || !ID.test(taskId)) return usage('Name one task: jevris task reconcile <task-id> --applied|--abandoned.');
  const applied = parsed.flags.has('--applied');
  if (applied === parsed.flags.has('--abandoned')) return usage('Say what happened: --applied or --abandoned (one of them).');
  const resolution = applied ? 'applied' : 'abandoned';
  const out = (result: object, text: string, code: number): number => {
    write(json ? `${JSON.stringify({ schemaVersion: '1.0', command: 'task reconcile', ...result })}\n` : `${text}\n`);
    return code;
  };

  const ctx = contextFor(parsed, options, options.ports ?? (await defaultPorts()));
  const refusedHome = homeRefusal(ctx);
  if (refusedHome !== null) return usage(refusedHome);
  if (ctx.workspaceRoot === null) return usage('No workspace here. Run this inside a repository or pass --workspace <dir>.');
  if (!(await authorized(parsed, options, `Record the held effect of task ${taskId} as ${resolution}? [y/N] `, write, json, 'This settles a held owned effect and unblocks its task'))) {
    return COMMAND_EXIT_CODES.usage;
  }
  if (ctx.autostart) {
    const ensured = await ctx.ports.sidecar.ensure({ home: ctx.home, waitMs: 5000 });
    if (!ensured.ok) return out({ reconciled: false, reasonCode: `SIDECAR_${ensured.reason.toUpperCase()}`, taskId }, 'The Jevris sidecar is not running, so nothing was reconciled. Start it with jevris sidecar start and retry.', COMMAND_EXIT_CODES.negative);
  }
  const actor = actorName();
  const answer = await ctx.ports.sidecar.request({
    home: ctx.home,
    op: 'task.reconcile',
    workspace: ctx.workspaceRoot,
    body: { taskId, resolution, ...(actor === undefined ? {} : { actor }) },
    scope: 'cli',
    timeoutMs: ctx.requestTimeoutMs,
    budget: 'hot',
  });
  if (!answer.ok) {
    const code = answer.reasonCode ?? `SIDECAR_${answer.reason.toUpperCase()}`;
    const hint = code === 'KILL_SWITCH' ? ' The kill switch is stopped; clear it first with jevris kill-switch clear.' : answer.reason === 'unavailable' ? ' Start the sidecar with jevris sidecar start and retry.' : '';
    return out({ reconciled: false, reasonCode: code, taskId }, `Nothing was reconciled (${code}).${hint}`, COMMAND_EXIT_CODES.negative);
  }
  const result = checkReconcileResult(answer.result, taskId);
  if (result === null) return out({ reconciled: false, reasonCode: 'SIDECAR_INVALID_RESULT', taskId }, 'The sidecar answered in an unexpected shape; the effect state is unknown. Run jevris status.', COMMAND_EXIT_CODES.negative);
  return out(result, render(result, resolution), result.reconciled ? COMMAND_EXIT_CODES.ok : COMMAND_EXIT_CODES.negative);
}

/**
 * `jevris task cancel <task-id>` (US21): D's `task.cancel` op (submit scope, CLI only, stopped by
 * the kill switch). The answer is the task.get payload, checked against its contract; the task
 * is cancelled only when that answer says so.
 */
async function runTaskCancel(argv: readonly string[], write: Write, options: VerifyAdminOptions): Promise<number> {
  const parsed = parse(argv, ['--home', '--workspace', '--duplicate-of'], ['--yes', '--json']);
  const json = typeof parsed !== 'string' && parsed.flags.has('--json');
  const usage = (message: string): number => {
    write(json ? `${JSON.stringify({ error: { code: 'USAGE', message } })}\n` : `${message}\nRun jevris help task for usage.\n`);
    return COMMAND_EXIT_CODES.usage;
  };
  if (typeof parsed === 'string') return usage(parsed);
  const taskId = parsed.positionals[0];
  if (parsed.positionals.length !== 1 || taskId === undefined || !ID.test(taskId)) return usage('Name one task: jevris task cancel <task-id>.');
  const survivor = parsed.values.get('--duplicate-of');
  if (survivor !== undefined && (!ID.test(survivor) || survivor === taskId)) return usage('--duplicate-of names the task you keep, not the one you cancel.');
  const out = (result: object, text: string, code: number): number => {
    write(json ? `${JSON.stringify({ schemaVersion: '1.0', command: 'task cancel', ...result })}\n` : `${text}\n`);
    return code;
  };
  const ctx = contextFor(parsed, options, options.ports ?? (await defaultPorts()));
  const refusedHome = homeRefusal(ctx);
  if (refusedHome !== null) return usage(refusedHome);
  if (ctx.workspaceRoot === null) return usage('No workspace here. Run this inside a repository or pass --workspace <dir>.');
  const question = survivor === undefined ? `Cancel task ${taskId}? Its worktree is kept. [y/N] ` : `Cancel task ${taskId} as a duplicate of ${survivor}? Its worktree is kept. [y/N] `;
  if (!(await authorized(parsed, options, question, write, json, 'This cancels an owned task'))) {
    return COMMAND_EXIT_CODES.usage;
  }
  if (ctx.autostart) {
    const ensured = await ctx.ports.sidecar.ensure({ home: ctx.home, waitMs: 5000 });
    if (!ensured.ok) return out({ cancelled: false, reasonCode: `SIDECAR_${ensured.reason.toUpperCase()}`, taskId }, 'The Jevris sidecar is not running, so nothing was cancelled. Start it with jevris sidecar start and retry.', COMMAND_EXIT_CODES.negative);
  }
  // A task already cancelled or verified is terminal: this call cancels nothing (D's TERMINAL).
  const before = await ctx.ports.sidecar.request({ home: ctx.home, op: 'task.get', workspace: ctx.workspaceRoot, body: { taskId }, scope: 'cli', timeoutMs: ctx.requestTimeoutMs, budget: 'hot' });
  const prior = before.ok ? surfacePayloadContract('task.get').validate(before.result) : null;
  if (prior !== null && prior.ok && prior.value.taskId === taskId && prior.value.task !== null && (prior.value.task.state === 'cancelled' || prior.value.task.state === 'verified')) {
    return out({ cancelled: false, reasonCode: 'NOT_CANCELLED', taskId, duplicateOf: survivor ?? null, task: prior.value.task }, `Task ${taskId} is already ${prior.value.task.state}; nothing was cancelled.`, COMMAND_EXIT_CODES.negative);
  }
  const answer = await ctx.ports.sidecar.request({ home: ctx.home, op: 'task.cancel', workspace: ctx.workspaceRoot, body: survivor === undefined ? { taskId } : { taskId, duplicateOf: survivor }, scope: 'cli', timeoutMs: ctx.requestTimeoutMs, budget: 'hot' });
  if (!answer.ok) {
    const code = answer.reasonCode ?? `SIDECAR_${answer.reason.toUpperCase()}`;
    const hint = code === 'KILL_SWITCH' ? ' The kill switch is stopped; clear it first with jevris kill-switch clear.' : answer.reason === 'unavailable' ? ' Start the sidecar with jevris sidecar start and retry.' : '';
    return out({ cancelled: false, reasonCode: code, taskId }, `Nothing was cancelled (${code}).${hint}`, COMMAND_EXIT_CODES.negative);
  }
  const checked = surfacePayloadContract('task.get').validate(answer.result);
  if (!checked.ok || checked.value.taskId !== taskId) return out({ cancelled: false, reasonCode: 'SIDECAR_INVALID_RESULT', taskId }, 'The sidecar answered in an unexpected shape; the task state is unknown. Run jevris status.', COMMAND_EXIT_CODES.negative);
  const view: SurfacePayloads['task.get'] = checked.value;
  if (!view.found || view.task === null) return out({ cancelled: false, reasonCode: 'UNKNOWN_TASK', taskId, task: null }, `There is no task ${taskId} in this workspace; nothing was cancelled.`, COMMAND_EXIT_CODES.negative);
  const cancelled = view.task.state === 'cancelled';
  return out(
    { cancelled, reasonCode: cancelled ? 'CANCELLED' : 'NOT_CANCELLED', taskId, duplicateOf: survivor ?? null, task: view.task },
    cancelled
      ? `Task ${taskId} is cancelled${survivor === undefined ? '' : ` as a duplicate of ${survivor}; if that was wrong, run jevris task revert-duplicate ${taskId}`}. Its worktree was kept.`
      : `Task ${taskId} was not cancelled; it is ${view.task.state}.`,
    cancelled ? COMMAND_EXIT_CODES.ok : COMMAND_EXIT_CODES.negative,
  );
}

const REVERT_TEXT: { readonly [code: string]: string } = {
  NOT_A_DUPLICATE_CANCELLATION: 'it was not cancelled as a duplicate (jevris task cancel --duplicate-of)',
  UNKNOWN_TASK: 'there is no such task in this workspace',
  NOT_CANCELLED: 'the task is not cancelled',
};

/** `jevris task revert-duplicate <task-id>`: a person says a duplicate cancellation was wrong (ORC-08). */
async function runTaskRevertDuplicate(argv: readonly string[], write: Write, options: VerifyAdminOptions): Promise<number> {
  const parsed = parse(argv, ['--home', '--workspace'], ['--yes', '--json']);
  const json = typeof parsed !== 'string' && parsed.flags.has('--json');
  const usage = (message: string): number => {
    write(json ? `${JSON.stringify({ error: { code: 'USAGE', message } })}\n` : `${message}\nRun jevris help task for usage.\n`);
    return COMMAND_EXIT_CODES.usage;
  };
  if (typeof parsed === 'string') return usage(parsed);
  const taskId = parsed.positionals[0];
  if (parsed.positionals.length !== 1 || taskId === undefined || !ID.test(taskId)) return usage('Name one task: jevris task revert-duplicate <task-id>.');
  const out = (result: object, text: string, code: number): number => {
    write(json ? `${JSON.stringify({ schemaVersion: '1.0', command: 'task revert-duplicate', ...result })}\n` : `${text}\n`);
    return code;
  };
  const ctx = contextFor(parsed, options, options.ports ?? (await defaultPorts()));
  const refusedHome = homeRefusal(ctx);
  if (refusedHome !== null) return usage(refusedHome);
  if (ctx.workspaceRoot === null) return usage('No workspace here. Run this inside a repository or pass --workspace <dir>.');
  if (!(await authorized(parsed, options, `Record that cancelling ${taskId} as a duplicate was wrong? [y/N] `, write, json, 'This records a false cancellation'))) {
    return COMMAND_EXIT_CODES.usage;
  }
  if (ctx.autostart) {
    const ensured = await ctx.ports.sidecar.ensure({ home: ctx.home, waitMs: 5000 });
    if (!ensured.ok) return out({ recorded: false, reasonCode: `SIDECAR_${ensured.reason.toUpperCase()}`, taskId }, 'The Jevris sidecar is not running, so nothing was recorded. Start it with jevris sidecar start and retry.', COMMAND_EXIT_CODES.negative);
  }
  const actor = actorName();
  const answer = await ctx.ports.sidecar.request({ home: ctx.home, op: 'task.revert-duplicate', workspace: ctx.workspaceRoot, body: actor === undefined ? { taskId } : { taskId, actor }, scope: 'cli', timeoutMs: ctx.requestTimeoutMs, budget: 'hot' });
  if (!answer.ok) {
    const code = answer.reasonCode ?? `SIDECAR_${answer.reason.toUpperCase()}`;
    const hint = code === 'KILL_SWITCH' ? ' The kill switch is stopped; clear it first with jevris kill-switch clear.' : answer.reason === 'unavailable' ? ' Start the sidecar with jevris sidecar start and retry.' : '';
    return out({ recorded: false, reasonCode: code, taskId }, `Nothing was recorded (${code}).${hint}`, COMMAND_EXIT_CODES.negative);
  }
  const raw = answer.result as { readonly [key: string]: unknown } | null;
  const recorded = raw?.['recorded'];
  const reasonCode = raw?.['reasonCode'];
  if (typeof recorded !== 'boolean' || typeof reasonCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(reasonCode) || raw?.['taskId'] !== taskId || recorded !== (reasonCode === 'FALSE_CANCELLATION_RECORDED')) {
    return out({ recorded: false, reasonCode: 'SIDECAR_INVALID_RESULT', taskId }, 'The sidecar answered in an unexpected shape, so nothing is shown. Run jevris status.', COMMAND_EXIT_CODES.negative);
  }
  return out(
    { recorded, reasonCode, taskId },
    recorded ? `Recorded: cancelling ${taskId} as a duplicate was wrong. Re-plan the work if you still need it.` : `Nothing was recorded: ${REVERT_TEXT[reasonCode] ?? reasonCode}.`,
    recorded ? COMMAND_EXIT_CODES.ok : COMMAND_EXIT_CODES.negative,
  );
}
