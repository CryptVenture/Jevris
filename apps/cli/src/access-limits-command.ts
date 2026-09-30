/**
 * `jevris route limits` and `jevris route limits clear` (access limits R78, design 9.2; with B's
 * `access-limits.clear` op).
 *
 * - The list reads the machine record through core's `readAccessLimits`; it needs no sidecar and
 *   changes nothing. It shows the pauses in force, numbered, with fixed text only (ids, classes,
 *   times): never a vendor's text.
 * - A clear lets routes use a paused scope again, so it needs a person at an interactive terminal:
 *   stdin and stdout TTYs, never `--json`, a pipe, a script, MCP, a hook or a test run. There is no
 *   `--yes`. Anything else is refused with CHANNEL_REFUSED before the record is read.
 * - A number is resolved against the record as it is read now, the entries are shown, and the person
 *   answers y/N. Only the keys of the entries shown are sent (for `--all` too), so an entry recorded
 *   after the question is never cleared by it, and a key that changed in between clears nothing.
 * - The sidecar clears under the record's lock and writes the audit row. A sidecar that is not
 *   running means nothing is cleared: the CLI never writes the record itself.
 */
import { personRequest } from './public/context.js';
import { ACCESS_PAUSE_CLASSES, AccessScopeSchema, COMMAND_EXIT_CODES, defineContract, schema as S } from '@jevris/contracts';
import { accessLimitLines, accessScopeText, readAccessLimits, type AccessLimitEntry } from '@jevris/core';
import { homeRefusal } from './public/home-guard.js';
import { defaultPorts } from './public/ports.js';
import { ROUTE_LIMITS_HELP } from './route-limits-help.js';
import { askOnTerminal, contextFor, parse, type VerifyAdminOptions } from './verify-admin.js';

type Write = (chunk: string) => void;

export interface RouteLimitsOptions extends VerifyAdminOptions {
  /** Whether stdin and stdout are an interactive terminal (default: both are TTYs). */
  readonly interactive?: () => boolean;
}

const KEY = /^[0-9a-f]{16}$/;
const NUMBER = /^[1-9][0-9]{0,3}$/;

/** B's `access-limits.clear` answer (apps/sidecar/src/access-limits-ops.ts). */
const ClearAnswerContract = defineContract({
  name: 'AccessLimitsClearAnswer',
  description: "The sidecar's answer to access-limits.clear: the entries it removed and whether the audit row was written.",
  schema: S.object({
    cleared: S.array(S.object({ key: S.string({ pattern: '^[0-9a-f]{16}$' }), class: S.enumOf(ACCESS_PAUSE_CLASSES), scope: AccessScopeSchema }), { maxItems: 128 }),
    audited: S.boolean(),
  }),
});

const REFUSAL_TEXT: { readonly [code: string]: string } = {
  CHANNEL_REFUSED: 'access pauses are cleared only by a person at an interactive terminal',
  INVALID_INPUT: 'the sidecar did not accept the list of pauses',
  WRITE_FAILED: 'the access-limit record could not be changed (it may be in use); retry in a moment',
  SIDECAR_INVALID_RESULT: 'the sidecar answered with something Jevris does not recognise',
};

/** The pauses in force, in the record's order: what the numbers refer to. */
function inForce(entries: readonly AccessLimitEntry[], nowMs: number): AccessLimitEntry[] {
  return entries.filter((e) => e.untilMs === null || e.untilMs > nowMs);
}

function numbered(entries: readonly AccessLimitEntry[], nowMs: number): string[] {
  return accessLimitLines(entries, nowMs).map((line, i) => `  ${String(i + 1).padStart(2)}  ${line}`);
}

function publicEntry(e: AccessLimitEntry, n: number): object {
  return { n, key: e.key, class: e.class, scope: e.scope, weekly: e.weekly, untilMs: e.untilMs, resetBasis: e.resetBasis, source: e.source, firstSeenMs: e.firstSeenMs, lastSeenMs: e.lastSeenMs, count: e.count };
}

function plural(n: number): string {
  return `${String(n)} access pause${n === 1 ? '' : 's'}`;
}

/** Runs `jevris route limits ...` (argv after `limits`). */
export async function runRouteLimitsCommand(argv: readonly string[], write: Write, options: RouteLimitsOptions = {}): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    write(`${ROUTE_LIMITS_HELP}\n`);
    return COMMAND_EXIT_CODES.ok;
  }
  const clearing = argv[0] === 'clear';
  const json = argv.includes('--json');
  const usage = (message: string): number => {
    write(json && !clearing ? `${JSON.stringify({ error: { code: 'USAGE', message } })}\n` : `${message}\nRun jevris route limits --help for usage.\n`);
    return COMMAND_EXIT_CODES.usage;
  };
  if (clearing && argv.includes('--yes')) return usage('jevris route limits clear has no --yes: it asks a person at an interactive terminal.');
  const parsed = parse(clearing ? argv.slice(1) : argv, ['--home'], clearing ? ['--all', '--json'] : ['--json']);
  if (typeof parsed === 'string') return usage(parsed);
  const nowMs = options.nowMs?.() ?? Date.now();
  const ctx = contextFor(parsed, options, options.ports ?? (await defaultPorts()));
  const refusedHome = homeRefusal(ctx);
  if (refusedHome !== null) return usage(refusedHome);

  if (!clearing) {
    if (parsed.positionals.length > 0) return usage(`Unexpected argument "${(parsed.positionals[0] ?? '').slice(0, 40)}".`);
    const record = await readAccessLimits(ctx.home);
    const active = inForce(record.entries, nowMs);
    if (json) {
      write(`${JSON.stringify({ schemaVersion: '1.0', command: 'route limits', readable: record.readable, full: record.full, entries: active.map((e, i) => publicEntry(e, i + 1)) })}\n`);
      return COMMAND_EXIT_CODES.ok;
    }
    const lines: string[] = [];
    if (!record.readable) lines.push('The access-limit record could not be read (ACCESS_LIMITS_UNREADABLE), so it pauses nothing; jevris doctor says more. Rewrite it empty with jevris route limits clear --all (at an interactive terminal).');
    else if (active.length === 0) lines.push('No access pauses in force.');
    else lines.push(`${plural(active.length)} in force (routes skip these until they lift):`, ...numbered(active, nowMs), 'Clear one with jevris route limits clear <n>, or every one with --all (at an interactive terminal).');
    if (record.full) lines.push('The record is full (ACCESS_LIMITS_FULL): a new pause replaces the oldest expired or timed one, and is not recorded while every one is untimed.');
    write(`${lines.join('\n')}\n`);
    return COMMAND_EXIT_CODES.ok;
  }

  // A clear: a person at a terminal first, before the record is read or the sidecar asked.
  const interactive = options.interactive ?? (() => process.stdin.isTTY === true && Reflect.get(process.stdout, 'isTTY') === true);
  if (json || ctx.env['JEVRIS_TEST'] === '1' || !interactive()) {
    write('Not cleared (CHANNEL_REFUSED): clearing an access pause lets Jevris route to it again, so it needs a person at an interactive terminal (never --json, MCP, a hook, a script, a pipe or a model\'s shell). Nothing changed.\n');
    return COMMAND_EXIT_CODES.usage;
  }
  const all = parsed.flags.has('--all');
  if (all === parsed.positionals.length > 0) return usage('Name the pauses to clear by their numbers from jevris route limits, or use --all (not both).');
  const bad = parsed.positionals.find((p) => !NUMBER.test(p));
  if (bad !== undefined) return usage(`"${bad.slice(0, 40)}" is not a number from jevris route limits.`);
  const numbers = parsed.positionals.map(Number);
  if (new Set(numbers).size !== numbers.length) return usage('A number was given twice.');

  const record = await readAccessLimits(ctx.home);
  // An unreadable record pauses nothing, and has no keys to name: only --all rewrites it empty.
  if (!record.readable && !all) {
    write('Nothing changed (ACCESS_LIMITS_UNREADABLE): the access-limit record could not be read, so it pauses nothing and has no numbered pauses. Rewrite it empty with jevris route limits clear --all.\n');
    return COMMAND_EXIT_CODES.negative;
  }
  const active = inForce(record.entries, nowMs);
  if (record.readable && active.length === 0) {
    write('No access pauses in force; nothing to clear.\n');
    return COMMAND_EXIT_CODES.ok;
  }
  const outOfRange = numbers.find((n) => n > active.length);
  if (outOfRange !== undefined) return usage(`There is no pause ${String(outOfRange)}: jevris route limits lists ${String(active.length)}.`);
  const reset = !record.readable;
  const chosen = all ? active : active.filter((_, i) => numbers.includes(i + 1));
  const keys = chosen.map((e) => e.key);
  if (!keys.every((k) => KEY.test(k))) {
    write('Nothing changed (ACCESS_LIMITS_UNREADABLE): an entry in the record has no valid key.\n');
    return COMMAND_EXIT_CODES.negative;
  }

  if (!reset) write(`${accessLimitLines(chosen, nowMs).map((l) => `  ${l}`).join('\n')}\n`);
  const confirm = options.confirm !== undefined && options.confirm !== null ? options.confirm : askOnTerminal;
  const question = reset ? 'The access-limit record could not be read (ACCESS_LIMITS_UNREADABLE). Rewrite it empty? It pauses nothing now. [y/N] ' : `Clear ${plural(chosen.length)}? Jevris will route to them again. [y/N] `;
  if (!(await confirm(question))) {
    write('Not cleared. Nothing changed.\n');
    return COMMAND_EXIT_CODES.negative;
  }

  const refused = (reasonCode: string): number => {
    const why =
      REFUSAL_TEXT[reasonCode] ??
      (reasonCode === 'SIDECAR_UNAVAILABLE' ? 'the Jevris sidecar is not running; start it with jevris sidecar start and retry' : reasonCode.startsWith('SIDECAR_') ? 'the Jevris sidecar did not answer; check jevris sidecar status and retry' : null);
    write(`Nothing changed (${reasonCode})${why === null ? '' : `: ${why}`}.\n`);
    return COMMAND_EXIT_CODES.negative;
  };
  if (ctx.autostart) {
    const ensured = await ctx.ports.sidecar.ensure({ home: ctx.home, waitMs: ctx.sidecarWaitMs });
    if (!ensured.ok) return refused(`SIDECAR_${ensured.reason.toUpperCase()}`);
  }
  const answer = await ctx.ports.sidecar.request({ home: ctx.home, op: 'access-limits.clear', workspace: ctx.workspaceRoot ?? '', body: { entries: reset ? 'all' : keys, channel: 'terminal' }, scope: 'cli', ...personRequest(ctx) });
  if (!answer.ok) return refused(answer.reasonCode ?? `SIDECAR_${answer.reason.toUpperCase()}`);
  const checked = ClearAnswerContract.validate(answer.result);
  if (!checked.ok || !checked.value.cleared.every((c) => keys.includes(c.key))) return refused('SIDECAR_INVALID_RESULT');
  const { cleared, audited } = checked.value;
  if (reset) {
    write(`The unreadable access-limit record was rewritten empty.${audited ? '' : ' The reset was not written to the audit log: the Jevris store refused the row.'}\n`);
    return COMMAND_EXIT_CODES.ok;
  }
  const lines =
    cleared.length === 0
      ? ['Nothing cleared: those pauses had already lifted or changed since they were shown. Run jevris route limits again.']
      : [`Cleared ${plural(cleared.length)}; Jevris routes to them again:`, ...cleared.map((c) => `  ${accessScopeText(c.scope)}: ${c.class}`)];
  if (cleared.length > 0 && cleared.length < keys.length) lines.push(`${plural(keys.length - cleared.length)} had already lifted or changed and were left as they are.`);
  if (cleared.length > 0 && !audited) lines.push('The clear was not written to the audit log: the Jevris store refused the row.');
  write(`${lines.join('\n')}\n`);
  return COMMAND_EXIT_CODES.ok;
}
