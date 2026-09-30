/**
 * `jevris feedback <decision-id>` (audit P12; owner decision 7922ee3): a person's feedback on one
 * decision's advice, through C's `decision.feedback` sidecar op (216d411, on B's 451506a). The
 * advice was accepted, or rejected with a reason: a preference, context Jevris did not have, or an
 * error. A rejection without a reason is recorded as unspecified. The latest feedback on a
 * decision wins. Feedback never changes a policy, a threshold or a route; `jevris cost-report`
 * shows it as hypotheses for a reviewed release. The op needs the submit scope, so no model tool
 * or hook can record feedback. It asks nothing. Every answer is checked before it is shown.
 */
import { personRequest } from './public/context.js';
import { COMMAND_EXIT_CODES } from '@jevris/contracts';
import { GIVEN_FEEDBACK_REASONS, isDecisionId } from '@jevris/core';
import { homeRefusal } from './public/home-guard.js';
import { defaultPorts } from './public/ports.js';
import { contextFor, parse, type VerifyAdminOptions } from './verify-admin.js';

type Write = (text: string) => void;

export const FEEDBACK_HELP = `Usage: jevris feedback <decision-id> --accepted [--json]
       jevris feedback <decision-id> --rejected [--json]
       jevris feedback <decision-id> --reason preference|unavailable-context|error [--json]

Records your feedback on one decision's advice (the decision id jevris status, jevris explain
or a hook's advice shows). The advice was accepted, or rejected: --reason says why (a
preference, context Jevris did not have, or an error in the advice), and --rejected without a
reason is recorded as unspecified. Only an error counts against the decision's accuracy. The
latest feedback on a decision replaces the earlier one.

Feedback never changes a policy, a threshold or a route: jevris cost-report shows it per
decision kind as hypotheses for a reviewed release. Only the CLI records feedback; no model tool
or hook can. It asks nothing and needs the Jevris sidecar.

Options:
  --accepted          The advice was accepted
  --rejected          The advice was rejected, without a reason
  --reason <reason>   The advice was rejected: preference, unavailable-context or error
  --home <dir>        Jevris home (default: JEVRIS_HOME, else your home directory)
  --workspace <dir>   Workspace (default: the repository containing the current directory)
  --json              Print one JSON result line

Exit codes: 0 recorded; 1 not recorded (no such decision in this workspace, the store is not
open, or the sidecar is not running); 2 usage error.

Examples:
  jevris feedback d-0123abcd-0000-4000-8000-000000000000 --accepted
  jevris feedback d-0123abcd-0000-4000-8000-000000000000 --reason unavailable-context`;

const LINE = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 500 && !/[\u0000-\u001f\u007f]/.test(x);

export interface FeedbackRecorded {
  readonly schemaVersion: 'jevris-decision-feedback-1';
  readonly recorded: true;
  readonly result: 'recorded' | 'replaced';
  readonly policyChanged: false;
  readonly lines: readonly string[];
}

/** C's decision.feedback answer, checked field by field; null when it does not match. */
export function checkFeedbackRecorded(raw: unknown): FeedbackRecorded | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as { readonly [key: string]: unknown };
  const lines = r['lines'];
  if (r['schemaVersion'] !== 'jevris-decision-feedback-1' || r['recorded'] !== true || r['policyChanged'] !== false) return null;
  if (r['result'] !== 'recorded' && r['result'] !== 'replaced') return null;
  if (!Array.isArray(lines) || lines.length > 8 || !lines.every(LINE)) return null;
  return { schemaVersion: 'jevris-decision-feedback-1', recorded: true, result: r['result'], policyChanged: false, lines: [...lines] };
}

const REFUSAL_TEXT: { readonly [code: string]: string } = {
  DECISION_NOT_FOUND: 'there is no such decision in this workspace',
  STORE_UNAVAILABLE: 'the Jevris store is not open',
  STORE_REFUSED: 'the store refused it; retry in a moment',
  INVALID_REQUEST: 'the sidecar did not accept the request',
};

/** Runs `jevris feedback ...` (argv after `feedback`). */
export async function runFeedbackCommand(argv: readonly string[], write: Write, options: VerifyAdminOptions = {}): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    write(`${FEEDBACK_HELP}\n`);
    return argv.length === 0 ? COMMAND_EXIT_CODES.usage : COMMAND_EXIT_CODES.ok;
  }
  const parsed = parse(argv, ['--home', '--workspace', '--reason'], ['--accepted', '--rejected', '--json']);
  const json = typeof parsed !== 'string' && parsed.flags.has('--json');
  const usage = (message: string): number => {
    write(json ? `${JSON.stringify({ error: { code: 'USAGE', message } })}\n` : `${message}\nRun jevris help feedback for usage.\n`);
    return COMMAND_EXIT_CODES.usage;
  };
  if (typeof parsed === 'string') return usage(parsed);
  const decisionId = parsed.positionals[0];
  if (parsed.positionals.length !== 1 || !isDecisionId(decisionId)) return usage('Name one decision: jevris feedback <decision-id>, an id such as d-0123abcd-0000-4000-8000-000000000000.');
  const accepted = parsed.flags.has('--accepted');
  const rejected = parsed.flags.has('--rejected');
  const reason = parsed.values.get('--reason');
  if (reason !== undefined && !(GIVEN_FEEDBACK_REASONS as readonly string[]).includes(reason)) return usage(`--reason takes one of ${GIVEN_FEEDBACK_REASONS.join(', ')}.`);
  if (accepted && (rejected || reason !== undefined)) return usage('Use --accepted, or --rejected / --reason <reason>, not both.');
  if (!accepted && !rejected && reason === undefined) return usage('Say whether the advice was accepted: --accepted, --rejected, or --reason <reason>.');

  const ctx = contextFor(parsed, options, options.ports ?? (await defaultPorts()));
  const refusedHome = homeRefusal(ctx);
  if (refusedHome !== null) return usage(refusedHome);
  if (ctx.workspaceRoot === null) return usage('No workspace here. Run this inside a repository or pass --workspace <dir>.');
  const out = (result: object, lines: readonly string[], code: number): number => {
    write(json ? `${JSON.stringify({ schemaVersion: '1.0', command: 'feedback', decisionId, ...result })}\n` : `${lines.join('\n')}\n`);
    return code;
  };
  const refused = (reasonCode: string): number => {
    const why = REFUSAL_TEXT[reasonCode] ?? (reasonCode.startsWith('SIDECAR_') && reasonCode !== 'SIDECAR_INVALID_RESULT' ? 'the Jevris sidecar is not running; start it with jevris sidecar start and retry' : null);
    return out({ recorded: false, reasonCode }, [`No feedback was recorded (${reasonCode})${why === null ? '' : `: ${why}`}.`], COMMAND_EXIT_CODES.negative);
  };
  if (ctx.autostart) {
    const ensured = await ctx.ports.sidecar.ensure({ home: ctx.home, waitMs: ctx.sidecarWaitMs });
    if (!ensured.ok) return refused(`SIDECAR_${ensured.reason.toUpperCase()}`);
  }
  const body = accepted ? { decisionId, accepted: true } : reason === undefined ? { decisionId, accepted: false } : { decisionId, accepted: false, reason };
  const answer = await ctx.ports.sidecar.request({ home: ctx.home, op: 'decision.feedback', workspace: ctx.workspaceRoot, body, scope: 'cli', ...personRequest(ctx) });
  if (!answer.ok) return refused(answer.reasonCode ?? `SIDECAR_${answer.reason.toUpperCase()}`);
  const recorded = checkFeedbackRecorded(answer.result);
  if (recorded === null) return refused('SIDECAR_INVALID_RESULT');
  return out({ recorded: true, reasonCode: null, result: recorded.result, accepted, reason: accepted ? null : (reason ?? 'unspecified'), policyChanged: false }, recorded.lines, COMMAND_EXIT_CODES.ok);
}
