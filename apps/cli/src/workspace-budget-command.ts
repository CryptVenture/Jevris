/**
 * `jevris configure workspace-budget [<micro-usd>|none] [--dry-run] [--workspace <dir>] [--json]`
 * (owner decision 2026-09-29): shows or changes this workspace's own monthly cap on Jevris's Jev
 * decision calls, inside the machine-wide limit (`decisions.monthlyBudgetMicroUsd`).
 *
 * The cap is kept per machine in D's host ledger, keyed by the workspace id, like owned mode; a
 * repository file is not consent, so a committed `.jevris/config.json` may only lower it. Setting
 * a first cap and lowering one need no one. Raising a cap, or removing it (`none`), lets Jevris
 * spend more, so it needs a person at an interactive terminal who answers y: --yes, --json, a
 * pipe, a script and a test run (JEVRIS_TEST=1) are refused with CHANNEL_REFUSED before anything
 * is asked. A dry run shows the change and writes nothing.
 */
import { userInfo } from 'node:os';
import { COMMAND_EXIT_CODES, JEV_BUDGET_MAX_MICRO_USD } from '@jevris/contracts';
import { jevBudgetText, machineJevBudget, raisesWorkspaceJevBudget, readWorkspaceJevBudgetCap, setWorkspaceJevBudgetCap, workspaceIdFor, workspaceJevBudget } from '@jevris/orchestrator';
import { defaultPorts } from './public/ports.js';
import { homeRefusal } from './public/home-guard.js';
import { contextFor, parse, personAtTerminal, type VerifyAdminOptions } from './verify-admin.js';

type Write = (text: string) => void;

const COMMAND = 'configure workspace-budget';

function amountText(microUsd: number): string {
  return `${microUsd} micro-USD (${jevBudgetText(microUsd)})`;
}

/** Runs `jevris configure workspace-budget ...` (argv starts at `workspace-budget`). */
export async function runWorkspaceBudget(argv: readonly string[], write: Write, options: VerifyAdminOptions = {}): Promise<number> {
  const parsed = parse(argv.slice(1), ['--home', '--workspace'], ['--json', '--yes', '--dry-run']);
  const json = typeof parsed !== 'string' && parsed.flags.has('--json');
  const usage = (message: string): number => {
    write(json ? `${JSON.stringify({ error: { code: 'USAGE', message } })}\n` : `${message}\nRun jevris help configure for usage.\n`);
    return COMMAND_EXIT_CODES.usage;
  };
  if (typeof parsed === 'string') return usage(parsed);
  const arg = parsed.positionals[0];
  if (parsed.positionals.length > 1) return usage('Use jevris configure workspace-budget [<micro-usd>|none].');
  let next: number | null | undefined;
  if (arg === undefined) next = undefined;
  else if (arg === 'none') next = null;
  else if (/^\d{1,10}$/.test(arg) && Number(arg) <= JEV_BUDGET_MAX_MICRO_USD) next = Number(arg);
  else return usage(`"${arg.slice(0, 40)}" is not a cap: give whole micro-USD from 0 to ${JEV_BUDGET_MAX_MICRO_USD} (1 USD is 1000000), or none.`);
  const ctx = contextFor(parsed, options, options.ports ?? (await defaultPorts()));
  const refusedHome = homeRefusal(ctx);
  if (refusedHome !== null) return usage(refusedHome);
  if (ctx.workspaceRoot === null) return usage('No workspace here. Run this inside a repository or pass --workspace <dir>.');
  const workspaceId = workspaceIdFor(ctx.workspaceRoot, options.platform ?? process.platform);
  const machine = machineJevBudget({ home: ctx.home, env: ctx.env });
  const stored = readWorkspaceJevBudgetCap(ctx.home, workspaceId);
  const current = stored.state === 'set' ? stored.record.capMicroUsd : null;

  const answer = (changed: boolean, dryRun: boolean): number => {
    const view = workspaceJevBudget({ home: ctx.home, env: ctx.env, workspaceId, workspaceRoot: ctx.workspaceRoot });
    const cap = dryRun ? next ?? null : view.stored.state === 'set' ? view.stored.record.capMicroUsd : null;
    const lines = [
      stored.state === 'unreadable' && !changed
        ? `This workspace's cap record cannot be read, so its Jev decisions run rules-only (cap 0) until you set the cap again.`
        : cap === null
          ? `This workspace has no cap of its own${dryRun ? ' after this change' : ''}: its Jev decisions share the machine-wide limit.`
          : `This workspace's monthly Jev decision cap${dryRun ? ' would be' : ' is'} ${amountText(cap)}${cap === 0 ? ': no Jev calls here, decisions run rules-only' : ''}.`,
      `Machine-wide limit: ${amountText(machine)} (decisions.monthlyBudgetMicroUsd); every workspace's decisions count against it.`,
    ];
    if (view.repositoryMicroUsd !== null) lines.push(`The repository's .jevris/config.json lowers this workspace to ${amountText(view.repositoryMicroUsd)}; the lower of the two applies.`);
    lines.push(dryRun ? 'Dry run: nothing was written.' : changed ? 'Saved. It applies to the next decision; this month\'s spend is kept.' : 'Unchanged.');
    const result = {
      workspaceId,
      capMicroUsd: cap,
      stored: stored.state,
      repositoryMicroUsd: view.repositoryMicroUsd,
      effectiveCapMicroUsd: dryRun ? (cap === null ? view.repositoryMicroUsd : view.repositoryMicroUsd === null ? cap : Math.min(cap, view.repositoryMicroUsd)) : view.capMicroUsd,
      machineMicroUsd: machine,
      changed,
      dryRun,
    };
    write(json ? `${JSON.stringify({ schemaVersion: '1.0', command: COMMAND, result })}\n` : `${lines.join('\n')}\n`);
    return COMMAND_EXIT_CODES.ok;
  };

  if (next === undefined) return answer(false, false);
  const same = stored.state !== 'unreadable' && current === next;
  if (same) return answer(false, false);
  if (parsed.flags.has('--dry-run')) return answer(false, true);
  // A higher cap, or none, lets Jevris spend more on Jev calls: a person at a terminal (SR-19).
  if (raisesWorkspaceJevBudget(stored, next)) {
    const target = next === null ? 'none' : String(next);
    const what = `raising this workspace's Jev decision cap to ${target} lets Jevris spend more on Jev calls`;
    let refusal = '';
    const ok = await personAtTerminal(
      { yes: parsed.flags.has('--yes'), json, env: ctx.env, interactive: options.interactive, confirm: options.confirm },
      `Raise this workspace's Jev decision cap to ${next === null ? 'none (the machine-wide limit)' : amountText(next)}? It lets Jevris spend more on Jev calls. [y/N] `,
      (text) => (refusal += text),
      what,
    );
    if (refusal.length > 0) {
      write(json ? `${JSON.stringify({ error: { code: 'CHANNEL_REFUSED', message: refusal.trim() } })}\n` : refusal);
      return COMMAND_EXIT_CODES.usage;
    }
    if (!ok) {
      write(json ? `${JSON.stringify({ error: { code: 'USAGE', message: 'Nothing was changed.' } })}\n` : 'Nothing was changed.\n');
      return COMMAND_EXIT_CODES.usage;
    }
  }
  let actor = 'cli';
  try {
    actor = userInfo().username;
  } catch {
    actor = 'cli';
  }
  const set = await setWorkspaceJevBudgetCap({ home: ctx.home, workspaceId, capMicroUsd: next, channel: 'cli', actor, nowMs: ctx.nowMs() });
  if (!set.ok) return usage(`The workspace cap was not changed (${set.reasonCode}).`);
  return answer(true, false);
}
