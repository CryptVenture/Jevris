/** `jevris route limits` help: one source, shown by `--help`, `jevris help route` and docs. */
import { ACCESS_UNTIMED_CLEAR_HELP } from '@jevris/core';
import { wrapText } from './terminal.js';

export const ROUTE_LIMITS_HELP = `Usage: jevris route limits [--json]
       jevris route limits clear <n>... | --all

Lists the access pauses in force on this machine: a harness, sign-in and serving host (or one
model or family on it) that reported a rate limit, a used-up usage window or credit, or a
blocked account. Routes skip a paused scope until the pause lifts. A timed pause lifts at its
${wrapText(`reset. ${ACCESS_UNTIMED_CLEAR_HELP}`, 94, 0, 0).join('\n')}

clear removes the numbered pauses (or every pause listed) so Jevris routes to them again. It
needs a person at an interactive terminal: it shows the pauses and asks before it clears, has
no --yes, and is refused with --json, from a pipe, a script, MCP or a hook. It needs the Jevris
sidecar, which writes the audit row; if the sidecar is not running nothing is cleared. For
example, at a terminal: jevris route limits clear 2, or jevris route limits clear --all.

Options:
  <n>                 The number of a pause, as jevris route limits lists it (one or more)
  --all               Every pause listed
  --home <dir>        Jevris home (default: JEVRIS_HOME, else your home directory)
  --json              Print one JSON result line (the list only)

Exit codes: 0 listed, cleared or nothing to clear; 1 not cleared (declined or refused by the
sidecar); 2 usage error or no interactive terminal.

Examples:
  jevris route limits
  jevris route limits --json`;
