/**
 * `jevris integrate` (ORC-07, W04): integrate verified owned tasks, through D's integration ops.
 *
 *   jevris integrate <task-id>...        prepare an integration branch in its own worktree,
 *                                        apply the tasks, run the mandatory checks, and report
 *   jevris integrate status [<id>]       one integration report, or the recent ones
 *   jevris integrate approve <id>        a person's approval: fast-forward the main checkout
 *                                        to a ready integration commit; nothing is pushed
 *
 * All three are CLI-only: run and approve need the submit scope, which no MCP tool or hook
 * holds, and the sidecar refuses approve from any other client. Approve needs --yes or a y/N
 * answer on a terminal. Every answer is checked against D's shape before it is shown.
 */
import { userInfo } from 'node:os';
import { COMMAND_EXIT_CODES } from '@jevris/contracts';
import { homeRefusal } from './public/home-guard.js';
import { defaultPorts } from './public/ports.js';
import { authorized, contextFor, parse, type VerifyAdminOptions } from './verify-admin.js';

type Write = (text: string) => void;

export const INTEGRATE_HELP = `Usage: jevris integrate <task-id>... [--json]
       jevris integrate status [<integration-id>] [--json]
       jevris integrate approve <integration-id> [--yes] [--json]

Integrates verified owned tasks into your checkout, with your approval.

integrate <task-id>...  Prepares an integration branch in its own worktree from your checkout's
                        current commit, applies each task's change, and runs the mandatory
                        checks there. It reports ready, conflicts, checks-failed or blocked.
                        Your checkout is not touched.
status [<id>]           Shows one integration report, or the recent ones.
approve <id>            Your approval: fast-forwards your checkout to the ready integration
                        commit. It is refused if your checkout moved, has uncommitted changes,
                        or the integration changed since the report. Nothing is ever pushed.

Only the CLI can integrate or approve; no model tool or hook can.

Options:
  --yes               approve: confirm without the terminal question
  --home <dir>        Jevris home (default: JEVRIS_HOME, else your home directory)
  --workspace <dir>   Workspace (default: the repository containing the current directory)
  --json              Print one JSON result line

Exit codes: 0 ready, found or merged; 1 not ready, not found, not merged, or the sidecar is not
running; 2 usage error or not confirmed.

Examples:
  jevris integrate T1 T2
  jevris integrate status
  jevris integrate approve int-0123456789ab`;

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const INTEGRATION_ID = /^int-[0-9a-f]{12}$/;
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/;
const COMMIT = /^[0-9a-f]{40,64}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const STATES = new Set(['blocked', 'conflicts', 'checks-failed', 'ready', 'merged']);
const OUTCOMES = new Set(['applied', 'conflict', 'git-error', 'empty', 'not-verified', 'no-worktree', 'base-not-ancestor', 'unreadable']);
const MAX_TASKS = 32;

export interface IntegrationTask {
  readonly taskId: string;
  readonly outcome: string;
  readonly paths: readonly string[];
  readonly conflictPaths: readonly string[];
  /** For `git-error`: git's own message, bounded and redacted by the sidecar. */
  readonly error: string | null;
}

export interface IntegrationView {
  readonly id: string;
  readonly taskIds: readonly string[];
  readonly state: string;
  readonly reasonCode: string;
  readonly baseCommit: string | null;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly integrationCommit: string | null;
  readonly tasks: readonly IntegrationTask[];
  readonly checks: { readonly verified: boolean; readonly mandatoryCheckIds: readonly string[]; readonly failing: readonly string[]; readonly missingEvidence: readonly string[] } | null;
  readonly approvedBy: string | null;
  readonly mergedCommit: string | null;
}

type Rec = { readonly [key: string]: unknown };
const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);
const texts = (v: unknown, max: number, len = 1024): v is readonly string[] => Array.isArray(v) && v.length <= max && v.every((s) => typeof s === 'string' && s.length > 0 && s.length <= len && !s.includes('\0'));
const nullOr = (v: unknown, test: (s: string) => boolean): v is string | null => v === null || (typeof v === 'string' && test(v));

/** D's integration report, checked field by field; null when it does not match. */
export function checkIntegration(raw: unknown): IntegrationView | null {
  if (!isRec(raw)) return null;
  const { id, taskIds, state, reasonCode, baseCommit, branch, worktreePath, integrationCommit, tasks, checks, approvedBy, mergedCommit } = raw;
  if (typeof id !== 'string' || !INTEGRATION_ID.test(id)) return null;
  if (!texts(taskIds, MAX_TASKS, 128) || !taskIds.every((t) => TASK_ID.test(t))) return null;
  if (typeof state !== 'string' || !STATES.has(state) || typeof reasonCode !== 'string' || !CODE.test(reasonCode)) return null;
  if (!nullOr(baseCommit, (s) => COMMIT.test(s)) || !nullOr(integrationCommit, (s) => COMMIT.test(s)) || !nullOr(mergedCommit, (s) => COMMIT.test(s))) return null;
  if (!nullOr(branch, (s) => s.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(s)) || !nullOr(worktreePath, (s) => s.length <= 4096 && !s.includes('\0'))) return null;
  if (!nullOr(approvedBy, (s) => ACTOR.test(s))) return null;
  if (!Array.isArray(tasks) || tasks.length > MAX_TASKS) return null;
  const taskViews: IntegrationTask[] = [];
  for (const task of tasks) {
    if (!isRec(task) || typeof task['taskId'] !== 'string' || !TASK_ID.test(task['taskId']) || typeof task['outcome'] !== 'string' || !OUTCOMES.has(task['outcome'])) return null;
    if (!texts(task['paths'], 10_000) || !texts(task['conflictPaths'], 10_000)) return null;
    const error = task['error'];
    if (error !== undefined && (typeof error !== 'string' || error.length === 0 || error.length > 1000 || error.includes('\0'))) return null;
    taskViews.push({ taskId: task['taskId'], outcome: task['outcome'], paths: task['paths'], conflictPaths: task['conflictPaths'], error: error ?? null });
  }
  let checkView: IntegrationView['checks'] = null;
  if (checks !== null) {
    if (!isRec(checks) || typeof checks['verified'] !== 'boolean' || !texts(checks['mandatoryCheckIds'], 512, 128) || !texts(checks['failing'], 512, 128) || !texts(checks['missingEvidence'], 512, 1000)) return null;
    checkView = { verified: checks['verified'], mandatoryCheckIds: checks['mandatoryCheckIds'], failing: checks['failing'], missingEvidence: checks['missingEvidence'] };
  }
  return { id, taskIds, state, reasonCode, baseCommit, branch, worktreePath, integrationCommit, tasks: taskViews, checks: checkView, approvedBy, mergedCommit };
}

const short = (commit: string | null): string => (commit === null ? 'none' : commit.slice(0, 12));

export function renderIntegration(r: IntegrationView): string[] {
  const head =
    r.state === 'ready'
      ? `Integration ${r.id} is ready: approve it with jevris integrate approve ${r.id}.`
      : r.state === 'merged'
        ? `Integration ${r.id} was merged into your checkout at ${short(r.mergedCommit)}${r.approvedBy === null ? '' : ` (approved by ${r.approvedBy})`}; nothing was pushed.`
        : `Integration ${r.id} is ${r.state} (${r.reasonCode}); your checkout was not changed.`;
  const lines = [head, `tasks: ${r.taskIds.join(', ')}`, `base commit: ${short(r.baseCommit)}`, `integration commit: ${short(r.integrationCommit)}`];
  if (r.branch !== null) lines.push(`branch: ${r.branch}`);
  if (r.worktreePath !== null) lines.push(`worktree: ${r.worktreePath}`);
  for (const task of r.tasks) {
    lines.push(`- ${task.taskId}: ${task.outcome}${task.paths.length > 0 ? ` (${task.paths.length} path${task.paths.length === 1 ? '' : 's'})` : ''}`);
    for (const path of task.conflictPaths.slice(0, 20)) lines.push(`  conflict: ${path}`);
    if (task.error !== null) lines.push(`  git said: ${task.error}`);
  }
  if (r.checks !== null) {
    lines.push(`checks verified: ${r.checks.verified ? 'yes' : 'no'}`);
    if (r.checks.mandatoryCheckIds.length > 0) lines.push(`mandatory checks: ${r.checks.mandatoryCheckIds.join(', ')}`);
    if (r.checks.failing.length > 0) lines.push(`failing: ${r.checks.failing.join(', ')}`);
    for (const missing of r.checks.missingEvidence.slice(0, 20)) lines.push(`missing evidence: ${missing}`);
  }
  return lines;
}

const APPROVE_TEXT: { readonly [code: string]: string } = {
  NOT_READY: 'the integration is not ready',
  BASE_MOVED: 'your checkout moved since the integration was prepared; run jevris integrate again',
  CHECKOUT_DIRTY: 'your checkout has uncommitted changes; commit or stash them first',
  INTEGRATION_CHANGED: 'the integration branch changed since the report; run jevris integrate again',
  MERGE_FAILED: 'git could not fast-forward your checkout',
  UNKNOWN_INTEGRATION: 'there is no such integration in this workspace',
};

function actorName(): string | undefined {
  try {
    const name = userInfo().username;
    return ACTOR.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

/** Runs `jevris integrate ...` (argv after `integrate`). */
export async function runIntegrateCommand(argv: readonly string[], write: Write, options: VerifyAdminOptions = {}): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    write(`${INTEGRATE_HELP}\n`);
    return argv.length === 0 ? COMMAND_EXIT_CODES.usage : COMMAND_EXIT_CODES.ok;
  }
  const parsed = parse(argv, ['--home', '--workspace'], ['--yes', '--json']);
  const json = typeof parsed !== 'string' && parsed.flags.has('--json');
  const usage = (message: string): number => {
    write(json ? `${JSON.stringify({ error: { code: 'USAGE', message } })}\n` : `${message}\nRun jevris help integrate for usage.\n`);
    return COMMAND_EXIT_CODES.usage;
  };
  if (typeof parsed === 'string') return usage(parsed);
  const [first, ...rest] = parsed.positionals;
  const sub = first === 'status' || first === 'approve' ? first : 'run';
  const args = sub === 'run' ? parsed.positionals : rest;
  if (sub === 'run') {
    if (args.length === 0 || args.length > MAX_TASKS || !args.every((t) => TASK_ID.test(t)) || new Set(args).size !== args.length) return usage(`Name 1 to ${MAX_TASKS} distinct task ids: jevris integrate <task-id>...`);
  } else if (sub === 'status') {
    if (args.length > 1 || (args[0] !== undefined && !INTEGRATION_ID.test(args[0]))) return usage('Use jevris integrate status [<integration-id>], with an id such as int-0123456789ab.');
  } else if (args.length !== 1 || !INTEGRATION_ID.test(args[0] ?? '')) {
    return usage('Name one integration: jevris integrate approve <integration-id>.');
  }
  if (parsed.flags.has('--yes') && sub !== 'approve') return usage('--yes applies only to approve.');

  const ctx = contextFor(parsed, options, options.ports ?? (await defaultPorts()));
  const refusedHome = homeRefusal(ctx);
  if (refusedHome !== null) return usage(refusedHome);
  if (ctx.workspaceRoot === null) return usage('No workspace here. Run this inside a repository or pass --workspace <dir>.');
  const command = sub === 'run' ? 'integrate' : `integrate ${sub}`;
  const out = (result: object, lines: readonly string[], code: number): number => {
    write(json ? `${JSON.stringify({ schemaVersion: '1.0', command, ...result })}\n` : `${lines.join('\n')}\n`);
    return code;
  };
  const invalid = () => out({ reasonCode: 'SIDECAR_INVALID_RESULT' }, ['The sidecar answered in an unexpected shape, so nothing is shown. Run jevris status.'], COMMAND_EXIT_CODES.negative);

  if (sub === 'approve') {
    const id = args[0] as string;
    if (!(await authorized(parsed, options, `Fast-forward your checkout to integration ${id}? Nothing is pushed. [y/N] `, write, json, 'This moves your checkout to the integration commit'))) {
      return COMMAND_EXIT_CODES.usage;
    }
  }
  const actor = actorName();
  const answer = await ctx.ports.sidecar.request({
    home: ctx.home,
    op: sub === 'run' ? 'integration.run' : sub === 'status' ? 'integration.get' : 'integration.approve',
    workspace: ctx.workspaceRoot,
    body: sub === 'run' ? { taskIds: args } : sub === 'status' ? (args[0] === undefined ? {} : { integrationId: args[0] }) : { integrationId: args[0], ...(actor === undefined ? {} : { actor }) },
    scope: 'cli',
    timeoutMs: sub === 'status' ? ctx.requestTimeoutMs : Math.max(ctx.requestTimeoutMs, 300_000),
    budget: sub === 'status' ? 'hot' : 'background',
  });
  if (!answer.ok) {
    const code = answer.reasonCode ?? `SIDECAR_${answer.reason.toUpperCase()}`;
    const hint = code === 'KILL_SWITCH' ? ' The kill switch is stopped; clear it first with jevris kill-switch clear.' : answer.reason === 'unavailable' ? ' Start the sidecar with jevris sidecar start and retry.' : '';
    return out({ reasonCode: code }, [`Nothing was done (${code}).${hint}`], COMMAND_EXIT_CODES.negative);
  }
  const body = answer.result;
  if (sub === 'run') {
    const report = checkIntegration(body);
    if (report === null) return invalid();
    return out({ report }, renderIntegration(report), report.state === 'ready' ? COMMAND_EXIT_CODES.ok : COMMAND_EXIT_CODES.negative);
  }
  if (sub === 'status') {
    if (!isRec(body) || typeof body['found'] !== 'boolean' || !Array.isArray(body['reports']) || body['reports'].length > 20) return invalid();
    const reports = body['reports'].map(checkIntegration);
    if (reports.some((r) => r === null)) return invalid();
    const views = reports as IntegrationView[];
    const lines = views.length === 0 ? [args[0] === undefined ? 'No integrations in this workspace yet.' : `There is no integration ${args[0]} in this workspace.`] : views.flatMap((r, i) => (i === 0 ? renderIntegration(r) : ['', ...renderIntegration(r)]));
    return out({ found: body['found'], reports: views }, lines, body['found'] ? COMMAND_EXIT_CODES.ok : COMMAND_EXIT_CODES.negative);
  }
  if (!isRec(body) || typeof body['merged'] !== 'boolean' || typeof body['reasonCode'] !== 'string' || !CODE.test(body['reasonCode'])) return invalid();
  const merged = body['merged'];
  const reasonCode = body['reasonCode'];
  if (merged !== (reasonCode === 'MERGED')) return invalid();
  const report = body['report'] === null ? null : checkIntegration(body['report']);
  if (body['report'] !== null && report === null) return invalid();
  const lines = merged && report !== null ? renderIntegration(report) : [`Not merged: ${APPROVE_TEXT[reasonCode] ?? reasonCode} (${reasonCode}). Your checkout was not changed.`, ...(report === null ? [] : renderIntegration(report).slice(1))];
  return out({ merged, reasonCode, report }, lines, merged ? COMMAND_EXIT_CODES.ok : COMMAND_EXIT_CODES.negative);
}
