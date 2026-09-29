/**
 * `jevris credential reenable` (coordinator decision ea2af91a on A's R77 finding; C2's core
 * `clearDisabled`, B's `jev.reenable` op).
 *
 * - After the provider refused billing (402) or the account (403), Jev decisions stay disabled
 *   until a person says the cause is fixed. Re-enabling lets billed Jev calls start again, so it
 *   needs a person at an interactive terminal: stdin and stdout TTYs, never `--json`, a pipe, a
 *   script, MCP, a hook or a test run. There is no `--yes`. Anything else is refused with
 *   CHANNEL_REFUSED before the sidecar is asked.
 * - The person answers y/N. Nothing calls Jev here: the next call comes from ordinary use.
 * - The disable lives in the sidecar's engine, the one writer of the circuit file. A sidecar that
 *   is not running means nothing changes (SIDECAR_NOT_RUNNING): the CLI never writes that file and
 *   never starts the sidecar for this.
 * - A key refusal (401) is not cleared here: it stays until the key changes, with
 *   `jevris credential set` (AUTH_NEEDS_NEW_KEY).
 * - Every text is fixed: reason codes and classes, never a key, a fingerprint or remote text.
 */
import { COMMAND_EXIT_CODES, defineContract, schema as S } from '@jevris/contracts';
import { OPERATOR_HELP } from './operator-help.js';
import { homeRefusal } from './public/home-guard.js';
import { defaultPorts } from './public/ports.js';
import { askOnTerminal, contextFor, parse, type VerifyAdminOptions } from './verify-admin.js';

type Write = (chunk: string) => void;

export interface CredentialReenableOptions extends VerifyAdminOptions {
  /** Whether stdin and stdout are an interactive terminal (default: both are TTYs). */
  readonly interactive?: () => boolean;
}

/** B's `jev.reenable` answer (apps/sidecar/src/jev-reenable-ops.ts). */
const ReenableAnswerContract = defineContract({
  name: 'JevReenableAnswer',
  description: "The sidecar's answer to jev.reenable: which disable it cleared, whether the circuit file was written, and whether the audit row was.",
  schema: S.object({
    cleared: S.enumOf(['BILLING', 'ACCOUNT'] as const),
    persisted: S.boolean(),
    audited: S.boolean(),
  }),
});

const CLASS_WORDS = { BILLING: 'billing (402)', ACCOUNT: 'the account (403)' } as const;

const REFUSAL_TEXT: { readonly [code: string]: string } = {
  CHANNEL_REFUSED: 'Jev is re-enabled only by a person at an interactive terminal',
  WRITE_FAILED: 'the Jev circuit state could not be changed; retry in a moment',
  SIDECAR_NOT_RUNNING: 'the Jevris sidecar is not running, and the disable is held in its state; start it with jevris sidecar start and retry',
  SIDECAR_CLIENT_MISSING: 'the Jevris sidecar client is not installed; reinstall Jevris',
  FOREIGN_LOCALITY: 'the sidecar for this home runs in another execution environment (a container, WSL or another host); run this there, or set JEVRIS_HOME to a directory inside this environment',
  MODE_OFF: 'Jevris is off, and in off mode it makes no Jev call, not even a probe; run `jevris configure set mode advise` first',
};

/** Runs `jevris credential reenable ...` (argv after `reenable`). */
export async function runCredentialReenableCommand(argv: readonly string[], write: Write, options: CredentialReenableOptions = {}): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    write(`${OPERATOR_HELP['credential'] ?? ''}\n`);
    return COMMAND_EXIT_CODES.ok;
  }
  const usage = (message: string): number => {
    write(`${message}\nRun jevris credential --help for usage.\n`);
    return COMMAND_EXIT_CODES.usage;
  };
  if (argv.includes('--yes')) return usage('jevris credential reenable has no --yes: it asks a person at an interactive terminal.');
  const parsed = parse(argv, ['--home'], ['--json']);
  if (typeof parsed === 'string') return usage(parsed);
  if (parsed.positionals.length > 0) return usage(`Unexpected argument "${(parsed.positionals[0] ?? '').slice(0, 40)}".`);
  const ctx = contextFor(parsed, options, options.ports ?? (await defaultPorts()));
  const refusedHome = homeRefusal(ctx);
  if (refusedHome !== null) return usage(refusedHome);

  // A person at a terminal first, before the sidecar is asked.
  const interactive = options.interactive ?? (() => process.stdin.isTTY === true && Reflect.get(process.stdout, 'isTTY') === true);
  if (parsed.flags.has('--json') || ctx.env['JEVRIS_TEST'] === '1' || !interactive()) {
    write("Not re-enabled (CHANNEL_REFUSED): re-enabling Jev lets billed Jev calls start again, so it needs a person at an interactive terminal (never --json, MCP, a hook, a script, a pipe or a model's shell). Nothing changed.\n");
    return COMMAND_EXIT_CODES.usage;
  }

  write('Jev decisions stay disabled after the provider refused billing (402) or the account (403); Jevris decides rules-only meanwhile. Re-enable only once that is fixed at the provider: a fresh refusal disables it again at once. A refused key (401) is not cleared here; store a new key with jevris credential set.\n');
  const confirm = options.confirm !== undefined && options.confirm !== null ? options.confirm : askOnTerminal;
  if (!(await confirm('Re-enable Jev decisions? Jevris calls nothing now; the next Jev call comes from ordinary use and is billed. [y/N] '))) {
    write('Not re-enabled. Nothing changed.\n');
    return COMMAND_EXIT_CODES.negative;
  }

  const refused = (reasonCode: string): number => {
    const why = REFUSAL_TEXT[reasonCode] ?? (reasonCode.startsWith('SIDECAR_') ? 'the Jevris sidecar did not answer; check jevris sidecar status and retry' : null);
    write(`Nothing changed (${reasonCode})${why === null ? '' : `: ${why}`}.\n`);
    return COMMAND_EXIT_CODES.negative;
  };
  // Never started for this: the disable is the running sidecar's state.
  const answer = await ctx.ports.sidecar.request({ home: ctx.home, op: 'jev.reenable', workspace: ctx.workspaceRoot ?? '', body: { channel: 'terminal' }, scope: 'cli', timeoutMs: ctx.requestTimeoutMs, budget: 'hot' });
  // After the op may have run (a timeout, an answer Jevris cannot read), whether Jev was
  // re-enabled is unknown: never reported as unchanged (B's LOW 34).
  const unconfirmed = (reasonCode: string, why: string): number => {
    write(`Not confirmed (${reasonCode}): ${why}, so whether Jev was re-enabled is unknown. jevris status shows a jev: line while Jev is still disabled.\n`);
    return COMMAND_EXIT_CODES.negative;
  };
  if (!answer.ok && answer.reason === 'timeout') return unconfirmed(answer.reasonCode ?? 'SIDECAR_TIMEOUT', 'the sidecar did not answer in time');
  if (!answer.ok) {
    // B's client answers `unavailable` with NOT_RUNNING, CONNECT_FAILED or KEY_UNREADABLE when no
    // sidecar of this home answers; a missing client or a foreign one keeps its own code.
    const stopped = answer.reason === 'unavailable' && answer.reasonCode !== 'SIDECAR_CLIENT_MISSING' && answer.reasonCode !== 'FOREIGN_LOCALITY';
    const code = stopped ? 'SIDECAR_NOT_RUNNING' : (answer.reasonCode ?? `SIDECAR_${answer.reason.toUpperCase()}`);
    if (code === 'NOT_DISABLED') {
      write('Jev is not disabled; nothing to re-enable. Nothing changed.\n');
      return COMMAND_EXIT_CODES.ok;
    }
    if (code === 'AUTH_NEEDS_NEW_KEY') {
      write('Not re-enabled (AUTH_NEEDS_NEW_KEY): the provider refused the key itself (401), and that clears only with a new key: jevris credential set. Nothing changed.\n');
      return COMMAND_EXIT_CODES.negative;
    }
    return refused(code);
  }
  const checked = ReenableAnswerContract.validate(answer.result);
  if (!checked.ok) return unconfirmed('SIDECAR_INVALID_RESULT', 'the sidecar answered with something Jevris does not recognise');
  const { cleared, persisted, audited } = checked.value;
  const lines = [`Jev re-enabled after ${CLASS_WORDS[cleared]}: Jevris observes first and acts again after the usual successful calls. Nothing was called now.`];
  if (!persisted) lines.push('The change holds only until the sidecar restarts: the circuit state file could not be written, so a restart brings the disable back.');
  if (!audited) lines.push('The re-enable was not written to the audit log: the Jevris store refused the row.');
  write(`${lines.join('\n')}\n`);
  return COMMAND_EXIT_CODES.ok;
}
