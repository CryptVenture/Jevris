/**
 * How a CLI command reports a failed operation that carries a reason code. Kept apart from
 * `runOperation` so a command that calls it directly (advise, delivery) reports a refusal the same
 * way the generic command path does.
 */
import { COMMAND_EXIT_CODES } from '@jevris/contracts';
import type { OperationOutcome } from './operations.js';

/**
 * Exit 1 keeps its code (the sidecar took the request and did not answer: not a refusal), and a
 * refusal with a code (MODE_OFF, CHANNEL_REFUSED, CONFIG_INVALID...) is
 * `Refused (<code>): <message>` with exit 2. Returns null for a failure with no code, which the
 * caller reports as a usage error. The one place these two lines are written, so a command that
 * calls runOperation directly cannot lose the code.
 */
export function refusalReport(
  outcome: Extract<OperationOutcome, { readonly ok: false }>,
  json: boolean,
): { readonly line: string; readonly exitCode: 1 | 2 } | null {
  if (outcome.exitCode === COMMAND_EXIT_CODES.negative) {
    return { line: json ? JSON.stringify({ error: { code: outcome.reasonCode, message: outcome.message } }) : `${outcome.message} (${outcome.reasonCode})`, exitCode: 1 };
  }
  if (outcome.reasonCode !== undefined) {
    return { line: json ? JSON.stringify({ error: { code: outcome.reasonCode, message: outcome.message } }) : `Refused (${outcome.reasonCode}): ${outcome.message}`, exitCode: 2 };
  }
  return null;
}
