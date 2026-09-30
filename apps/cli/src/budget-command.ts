/**
 * `jevris budget` (ORC-10, W09): a root budget's use and its last exhaustion, and a person's
 * answer to it, through D's budget ops.
 *
 *   jevris budget status <budget-id>    what the budget holds, what new work may still reserve,
 *                                       and the last exhaustion report with its suggestions
 *   jevris budget update <budget-id>    raise the limit (with a terminal authorization for
 *                                       budget.increase on this budget) and/or resume a budget
 *                                       the pause-all policy paused
 *
 * Update is CLI-only: it needs the submit scope, which no MCP tool or hook holds, the sidecar
 * refuses it from any other client, and the kill switch stops it. It needs --yes or a y/N
 * answer on a terminal. Every answer is checked against D's shape before it is shown.
 */
import { personRequest } from './public/context.js';
import { COMMAND_EXIT_CODES, ID_PATTERN } from '@jevris/contracts';
import { checkEstimates, estimatesLine, type EstimatesView } from './learning-report.js';
import { homeRefusal } from './public/home-guard.js';
import { defaultPorts } from './public/ports.js';
import { authorized, contextFor, parse, type VerifyAdminOptions } from './verify-admin.js';

type Write = (text: string) => void;

export const BUDGET_HELP = `Usage: jevris budget status <budget-id> [--json]
       jevris budget update <budget-id> [--limit-micro-usd <n> --authorization <id>] [--resume] [--yes] [--json]

Shows and changes a root budget of owned work.

status <budget-id>  What the budget holds, what new work may still reserve, and the last time it
                    ran out: the tasks refused, what its policy did to running work, and the
                    suggestions (narrow a task, a cheaper approved model, pause, or a higher
                    limit). Mandatory checks are never skipped to fit a budget. It also compares
                    the plan's task estimates with what its finished tasks committed.
update <budget-id>  Your answer: a higher limit, and/or --resume for a budget the pause-all
                    policy paused. Owned work then continues. A higher limit needs a single-use
                    authorization you mint first in a terminal:
                      jevris authorize budget.increase --scope <budget-id>
                    Only the CLI can update a budget; no model tool or hook can.

Options:
  --limit-micro-usd <n>  update: the new limit in micro-USD (1 USD = 1000000); must be higher
  --authorization <id>   update: the id jevris authorize printed for budget.increase
  --resume               update: resume a paused budget
  --yes                  update: confirm without the terminal question
  --home <dir>           Jevris home (default: JEVRIS_HOME, else your home directory)
  --workspace <dir>      Workspace (default: the repository containing the current directory)
  --json                 Print one JSON result line

Exit codes: 0 found or updated; 1 not found, not updated, or the sidecar is not running; 2 usage
error or not confirmed.

Examples:
  jevris budget status plan-1
  jevris budget update plan-1 --resume --yes
  jevris budget update plan-1 --limit-micro-usd 20000000 --authorization auth-0123 --yes`;

const ID = new RegExp(ID_PATTERN);
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const POLICIES = new Set(['finish-running', 'cancel-newest', 'pause-all']);
const KINDS = new Set(['narrow', 'cheaper-profile', 'pause', 'increase']);
const ACTIONS = new Set(['continue', 'cancelled', 'paused']);
const UPDATE_CODES = new Set(['UPDATED', 'UNKNOWN_BUDGET', 'NOTHING_TO_CHANGE', 'LIMIT_NOT_HIGHER', 'AUTHORIZATION_REFUSED']);
const MAX_ITEMS = 512;

type Rec = { readonly [key: string]: unknown };
const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);
const micro = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const idOrNull = (v: unknown): v is string | null => v === null || (typeof v === 'string' && ID.test(v));

export interface BudgetSuggestionView {
  readonly kind: string;
  readonly taskId: string | null;
  readonly model: string | null;
  readonly increaseToMicroUsd: number | null;
  readonly text: string;
}

export interface BudgetExhaustionView {
  readonly atMs: number;
  readonly open: boolean;
  readonly policy: string;
  readonly limitMicroUsd: number;
  readonly heldMicroUsd: number;
  readonly reserveMicroUsd: number;
  readonly availableMicroUsd: number;
  readonly refused: readonly { readonly taskId: string; readonly estimateMicroUsd: number; readonly reasonCode: string }[];
  readonly actions: readonly { readonly taskId: string; readonly action: string }[];
  readonly suggestions: readonly BudgetSuggestionView[];
  readonly mandatoryChecksKept: true;
  readonly increaseNeedsAuthorization: true;
}

export interface BudgetView {
  readonly found: boolean;
  readonly budget: { readonly id: string; readonly ownerId: string; readonly limitMicroUsd: number; readonly shutdownReserveMicroUsd: number; readonly policy: string; readonly paused: boolean } | null;
  readonly use: { readonly heldMicroUsd: number; readonly availableMicroUsd: number } | null;
  readonly exhaustion: BudgetExhaustionView | null;
  /** D's estimateAccuracy for this plan (2794ac4); null when the sidecar sends none or it does not match. */
  readonly estimates: EstimatesView | null;
}

function checkExhaustion(raw: unknown): BudgetExhaustionView | null | undefined {
  if (raw === null) return null;
  if (!isRec(raw)) return undefined;
  const { atMs, open, policy, limitMicroUsd, heldMicroUsd, reserveMicroUsd, availableMicroUsd, refused, actions, suggestions, mandatoryChecksKept, increaseNeedsAuthorization } = raw;
  if (!micro(atMs) || typeof open !== 'boolean' || typeof policy !== 'string' || !POLICIES.has(policy)) return undefined;
  if (!micro(limitMicroUsd) || !micro(heldMicroUsd) || !micro(reserveMicroUsd) || !micro(availableMicroUsd)) return undefined;
  if (mandatoryChecksKept !== true || increaseNeedsAuthorization !== true) return undefined;
  if (!Array.isArray(refused) || refused.length > MAX_ITEMS || !Array.isArray(actions) || actions.length > MAX_ITEMS || !Array.isArray(suggestions) || suggestions.length > MAX_ITEMS) return undefined;
  const refusedViews: BudgetExhaustionView['refused'][number][] = [];
  for (const r of refused) {
    if (!isRec(r) || typeof r['taskId'] !== 'string' || !ID.test(r['taskId']) || !micro(r['estimateMicroUsd']) || typeof r['reasonCode'] !== 'string' || !CODE.test(r['reasonCode'])) return undefined;
    refusedViews.push({ taskId: r['taskId'], estimateMicroUsd: r['estimateMicroUsd'], reasonCode: r['reasonCode'] });
  }
  const actionViews: BudgetExhaustionView['actions'][number][] = [];
  for (const a of actions) {
    if (!isRec(a) || typeof a['taskId'] !== 'string' || !ID.test(a['taskId']) || typeof a['action'] !== 'string' || !ACTIONS.has(a['action'])) return undefined;
    actionViews.push({ taskId: a['taskId'], action: a['action'] });
  }
  const suggestionViews: BudgetSuggestionView[] = [];
  for (const s of suggestions) {
    if (!isRec(s) || typeof s['kind'] !== 'string' || !KINDS.has(s['kind']) || !idOrNull(s['taskId'])) return undefined;
    const model = s['model'];
    const to = s['increaseToMicroUsd'];
    const text = s['text'];
    if (!(model === null || (typeof model === 'string' && MODEL.test(model))) || !(to === null || micro(to))) return undefined;
    if (typeof text !== 'string' || text.length === 0 || text.length > 1000 || text.includes('\0')) return undefined;
    suggestionViews.push({ kind: s['kind'], taskId: s['taskId'], model, increaseToMicroUsd: to, text });
  }
  return { atMs, open, policy, limitMicroUsd, heldMicroUsd, reserveMicroUsd, availableMicroUsd, refused: refusedViews, actions: actionViews, suggestions: suggestionViews, mandatoryChecksKept: true, increaseNeedsAuthorization: true };
}

/** D's budget view, checked field by field; null when it does not match. */
export function checkBudget(raw: unknown): BudgetView | null {
  if (!isRec(raw) || typeof raw['found'] !== 'boolean') return null;
  if (raw['found'] === false) return raw['budget'] === null && raw['use'] === null ? { found: false, budget: null, use: null, exhaustion: null, estimates: null } : null;
  const { budget, use } = raw;
  if (!isRec(budget) || !isRec(use)) return null;
  const { id, ownerId, limitMicroUsd, shutdownReserveMicroUsd, policy, paused } = budget;
  if (typeof id !== 'string' || !ID.test(id) || typeof ownerId !== 'string' || ownerId.length === 0 || ownerId.length > 128 || ownerId.includes('\0')) return null;
  if (!micro(limitMicroUsd) || !micro(shutdownReserveMicroUsd) || typeof policy !== 'string' || !POLICIES.has(policy) || typeof paused !== 'boolean') return null;
  if (!micro(use['heldMicroUsd']) || !micro(use['availableMicroUsd'])) return null;
  const exhaustion = checkExhaustion(raw['exhaustion']);
  if (exhaustion === undefined) return null;
  return { found: true, budget: { id, ownerId, limitMicroUsd, shutdownReserveMicroUsd, policy, paused }, use: { heldMicroUsd: use['heldMicroUsd'], availableMicroUsd: use['availableMicroUsd'] }, exhaustion, estimates: checkEstimates(raw['estimates']) };
}

const usd = (n: number): string => `${String(n)} micro-USD ($${(n / 1_000_000).toFixed(2)})`;

export function renderBudget(view: BudgetView): string[] {
  if (!view.found || view.budget === null || view.use === null) return ['There is no such budget in this workspace.'];
  const b = view.budget;
  const lines = [
    `Budget ${b.id}${b.paused ? ' is paused' : ''}: limit ${usd(b.limitMicroUsd)}, policy ${b.policy}.`,
    `held: ${usd(view.use.heldMicroUsd)}`,
    `available for new work: ${usd(view.use.availableMicroUsd)}`,
    `shutdown reserve: ${usd(b.shutdownReserveMicroUsd)}`,
  ];
  if (view.estimates !== null) lines.push(estimatesLine(view.estimates));
  const e = view.exhaustion;
  if (e === null) return lines;
  lines.push(`${e.open ? 'Ran out' : 'Last ran out'} at ${new Date(e.atMs).toISOString()}${e.open ? '' : ' (answered)'}: ${String(e.refused.length)} task${e.refused.length === 1 ? '' : 's'} refused.`);
  for (const r of e.refused.slice(0, 50)) lines.push(`- refused ${r.taskId}: needs ${usd(r.estimateMicroUsd)} (${r.reasonCode})`);
  for (const a of e.actions.slice(0, 50)) lines.push(`- ${a.taskId}: ${a.action}`);
  if (e.suggestions.length > 0) lines.push('Suggestions:');
  for (const s of e.suggestions.slice(0, 50)) lines.push(`- ${s.text}`);
  lines.push('Mandatory checks stay mandatory; a higher limit needs your terminal authorization.');
  return lines;
}

const UPDATE_TEXT: { readonly [code: string]: string } = {
  UNKNOWN_BUDGET: 'there is no such budget in this workspace',
  NOTHING_TO_CHANGE: 'give --limit-micro-usd or --resume',
  LIMIT_NOT_HIGHER: 'the new limit must be higher than the current one',
  AUTHORIZATION_REFUSED: 'the authorization is missing, used, expired, for another budget or for another person; mint one with jevris authorize budget.increase --scope <budget-id>',
};

/** The OS user, cleaned the way `jevris authorize` names the person it mints for. */
export function actorName(env: { readonly [key: string]: string | undefined }): string {
  const name = env['USER'] ?? env['USERNAME'] ?? 'cli';
  const cleaned = name.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 63);
  return /^[A-Za-z]/.test(cleaned) ? cleaned : `u${cleaned}`.slice(0, 64);
}

/** Runs `jevris budget ...` (argv after `budget`). */
export async function runBudgetCommand(argv: readonly string[], write: Write, options: VerifyAdminOptions = {}): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    write(`${BUDGET_HELP}\n`);
    return argv.length === 0 ? COMMAND_EXIT_CODES.usage : COMMAND_EXIT_CODES.ok;
  }
  const sub = argv[0];
  const parsed = parse(argv.slice(1), ['--home', '--workspace', '--limit-micro-usd', '--authorization'], ['--resume', '--yes', '--json']);
  const json = typeof parsed !== 'string' && parsed.flags.has('--json');
  const usage = (message: string): number => {
    write(json ? `${JSON.stringify({ error: { code: 'USAGE', message } })}\n` : `${message}\nRun jevris help budget for usage.\n`);
    return COMMAND_EXIT_CODES.usage;
  };
  if (sub !== 'status' && sub !== 'update') return usage(`Unknown budget subcommand ${String(sub).slice(0, 40)}. Use jevris budget status or jevris budget update.`);
  if (typeof parsed === 'string') return usage(parsed);
  const budgetId = parsed.positionals[0];
  if (parsed.positionals.length !== 1 || budgetId === undefined || !ID.test(budgetId)) return usage(`Name one budget: jevris budget ${sub} <budget-id>.`);
  const limitRaw = parsed.values.get('--limit-micro-usd');
  const authorizationId = parsed.values.get('--authorization');
  const resume = parsed.flags.has('--resume');
  let limit: number | undefined;
  if (sub === 'status') {
    if (limitRaw !== undefined || authorizationId !== undefined || resume || parsed.flags.has('--yes')) return usage('budget status takes only <budget-id> and --json.');
  } else {
    if (limitRaw !== undefined) {
      limit = /^[1-9][0-9]{0,15}$/.test(limitRaw) ? Number(limitRaw) : Number.NaN;
      if (!Number.isSafeInteger(limit)) return usage('--limit-micro-usd must be a positive whole number of micro-USD.');
      if (authorizationId === undefined) return usage('A higher limit needs --authorization <id>: run jevris authorize budget.increase --scope <budget-id> in a terminal first.');
    }
    if (authorizationId !== undefined && (limitRaw === undefined || !ID.test(authorizationId))) return usage('--authorization goes with --limit-micro-usd and takes the id jevris authorize printed.');
    if (limit === undefined && !resume) return usage('Give --limit-micro-usd <n> --authorization <id>, --resume, or both.');
  }

  const ctx = contextFor(parsed, options, options.ports ?? (await defaultPorts()));
  const refusedHome = homeRefusal(ctx);
  if (refusedHome !== null) return usage(refusedHome);
  if (ctx.workspaceRoot === null) return usage('No workspace here. Run this inside a repository or pass --workspace <dir>.');
  const command = `budget ${sub}`;
  const out = (result: object, lines: readonly string[], code: number): number => {
    write(json ? `${JSON.stringify({ schemaVersion: '1.0', command, ...result })}\n` : `${lines.join('\n')}\n`);
    return code;
  };
  if (sub === 'update') {
    const change = [limit === undefined ? null : `raise the limit to ${usd(limit)}`, resume ? 'resume it' : null].filter((s) => s !== null).join(' and ');
    if (!(await authorized(parsed, options, `Budget ${budgetId}: ${change}? Owned work then continues. [y/N] `, write, json, 'This changes what owned work may spend'))) {
      return COMMAND_EXIT_CODES.usage;
    }
  }
  const nothing = sub === 'update' ? 'nothing was changed' : 'nothing is shown';
  if (ctx.autostart) {
    const ensured = await ctx.ports.sidecar.ensure({ home: ctx.home, waitMs: 5000 });
    if (!ensured.ok) return out({ reasonCode: `SIDECAR_${ensured.reason.toUpperCase()}`, budgetId }, [`The Jevris sidecar is not running, so ${nothing}. Start it with jevris sidecar start and retry.`], COMMAND_EXIT_CODES.negative);
  }
  const body =
    sub === 'status'
      ? { budgetId }
      : { budgetId, ...(limit === undefined ? {} : { limitMicroUsd: limit, authorizationId }), ...(resume ? { resume: true } : {}), actor: actorName(options.env ?? process.env) };
  const answer = await ctx.ports.sidecar.request({ home: ctx.home, op: sub === 'status' ? 'budget.get' : 'budget.update', workspace: ctx.workspaceRoot, body, scope: 'cli', ...personRequest(ctx) });
  if (!answer.ok) {
    const code = answer.reasonCode ?? `SIDECAR_${answer.reason.toUpperCase()}`;
    const hint = code === 'KILL_SWITCH' ? ' The kill switch is stopped; clear it first with jevris kill-switch clear.' : answer.reason === 'unavailable' ? ' Start the sidecar with jevris sidecar start and retry.' : '';
    return out({ ...(sub === 'update' ? { updated: false } : {}), reasonCode: code, budgetId }, [`${nothing[0]?.toUpperCase() ?? ''}${nothing.slice(1)} (${code}).${hint}`], COMMAND_EXIT_CODES.negative);
  }
  const view = checkBudget(answer.result);
  const raw = isRec(answer.result) ? answer.result : {};
  const reasonCode = raw['reasonCode'];
  const invalid = view === null || (view.found && view.budget?.id !== budgetId) || (sub === 'update' && (typeof raw['updated'] !== 'boolean' || typeof reasonCode !== 'string' || !UPDATE_CODES.has(reasonCode) || (raw['updated'] === true) !== (reasonCode === 'UPDATED')));
  if (invalid || view === null) return out({ reasonCode: 'SIDECAR_INVALID_RESULT', budgetId }, ['The sidecar answered in an unexpected shape, so nothing is shown. Run jevris status.'], COMMAND_EXIT_CODES.negative);
  if (sub === 'status') {
    return out({ budgetId, ...view }, renderBudget(view), view.found ? COMMAND_EXIT_CODES.ok : COMMAND_EXIT_CODES.negative);
  }
  const updated = reasonCode === 'UPDATED';
  const head = updated ? `Budget ${budgetId} was updated; owned work continues under it.` : `Budget ${budgetId} was not changed: ${UPDATE_TEXT[reasonCode as string] ?? String(reasonCode)}.`;
  return out({ updated, reasonCode, budgetId, ...view }, [head, ...(view.found ? renderBudget(view) : [])], updated ? COMMAND_EXIT_CODES.ok : COMMAND_EXIT_CODES.negative);
}
