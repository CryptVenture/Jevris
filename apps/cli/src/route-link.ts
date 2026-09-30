/**
 * `jevris route --task <id> --link` and `jevris route --unlink` (owner decision 29423b6; B's
 * session.link op, coordinator decision c065d52). A Kilo or OpenCode main session may be switched
 * per turn only when it is linked to its task; this is how a person links the session they are
 * working in.
 *
 * - The sidecar resolves the session from its own records: `--session` is only a hint that must
 *   match a recorded, active main session exactly, and without it exactly one such session may have
 *   been seen recently. When more than one could be meant, the candidates are listed and nothing is
 *   linked: the CLI never picks one.
 * - A link (and `--replace`) widens what a turn may do, so it needs a person at an interactive
 *   terminal (B's security review); a model's shell, a pipe, MCP or a hook cannot link. Unlinking
 *   only tightens and works anywhere on the CLI.
 * - The answer always names the session it linked, so a wrong guess is visible; status shows it.
 */
import { COMMAND_EXIT_CODES, HARNESS_IDS, ID_PATTERN, SESSION_ID_PATTERN, SessionLinkResultContract, type SessionLinkResult } from '@jevris/contracts';
import { homeRefusal } from './public/home-guard.js';
import { defaultPorts } from './public/ports.js';
import type { SurfaceContext } from './public/context.js';
import { personRequest } from './public/context.js';
import { contextFor, parse, type VerifyAdminOptions } from './verify-admin.js';

type Write = (chunk: string) => void;

export interface RouteLinkOptions extends VerifyAdminOptions {
  /** Whether stdin and stdout are an interactive terminal (default: both are TTYs). */
  readonly interactive?: () => boolean;
}

const REFUSAL_TEXT: { readonly [code: string]: string } = {
  UNKNOWN_SESSION: 'Jevris has no active session of that harness recorded in this workspace; start the session, send one message, then retry',
  SESSION_ENDED: 'that session has ended',
  TASK_UNKNOWN: 'there is no such task in this workspace',
  TASK_NOT_ACTIVE: 'the task is not approved or running',
  SESSION_ALREADY_LINKED: 'the session is linked to another task; add --replace to link it to this one',
  CHANNEL_REFUSED: 'a link needs a person at an interactive terminal',
  KILL_SWITCH_ACTIVE: 'the kill switch is set, so no new link is made',
  STORE_UNAVAILABLE: 'the Jevris store is not open',
  STORE_REFUSED: 'the store refused it; retry in a moment',
  PAYLOAD_INVALID: 'the sidecar could not form a valid answer',
  INVALID_REQUEST: 'the sidecar did not accept the request',
  SIDECAR_INVALID_RESULT: 'the sidecar answered with something Jevris does not recognise',
  NO_WORKSPACE: 'run it inside the repository the session works in, or name it with --workspace',
};

const TASK = new RegExp(ID_PATTERN);
const SESSION = new RegExp(SESSION_ID_PATTERN);

/** The last 8 characters of a session id, enough to tell sessions apart on screen. */
function shortSession(id: string): string {
  return id.length <= 12 ? id : `…${id.slice(-8)}`;
}

function when(atMs: number): string {
  return new Date(atMs).toISOString().replace('T', ' ').slice(0, 16);
}

/** What a link or unlink came to: the JSON fields, the human lines and the exit code. */
export interface LinkOutcome {
  readonly code: number;
  readonly result: { readonly [key: string]: unknown };
  readonly lines: readonly string[];
}

/** No person at a terminal: a link widens what a turn may do, so it is refused before anything runs. */
export function linkTerminalRefusal(env: { readonly [key: string]: string | undefined }, options: { readonly interactive?: () => boolean }): LinkOutcome | null {
  const interactive = options.interactive ?? (() => process.stdin.isTTY === true && Reflect.get(process.stdout, 'isTTY') === true);
  if (env['JEVRIS_TEST'] !== '1' && interactive()) return null;
  return {
    code: COMMAND_EXIT_CODES.usage,
    result: { changed: false, reasonCode: 'CHANNEL_REFUSED' },
    lines: ["Not linked: linking a session to a task lets Jevris switch its model per turn, so it needs a person at an interactive terminal (never MCP, a hook, a script, a pipe or a model's shell). Nothing changed."],
  };
}

export interface LinkRequest {
  readonly action: 'link' | 'unlink';
  readonly taskId?: string;
  readonly harness?: string;
  readonly session?: string;
  readonly replace?: boolean;
  /** Where the link came from, when the sidecar's op takes it (a handoff import); default route. */
  readonly via?: 'handoff';
}

/**
 * Asks B's session.link or session.unlink and says what came of it. The caller has already checked
 * the terminal for a link. The sidecar resolves the session from its own records.
 */
export async function requestSessionLink(ctx: SurfaceContext, request: LinkRequest): Promise<LinkOutcome> {
  const refused = (reasonCode: string): LinkOutcome => {
    const why = REFUSAL_TEXT[reasonCode] ?? (reasonCode.startsWith('SIDECAR_') ? 'the Jevris sidecar is not running; start it with jevris sidecar start and retry' : null);
    return { code: COMMAND_EXIT_CODES.negative, result: { changed: false, reasonCode }, lines: [`Nothing changed (${reasonCode})${why === null ? '' : `: ${why}`}.`] };
  };
  if (ctx.workspaceRoot === null) return refused('NO_WORKSPACE');
  if (ctx.autostart) {
    const ensured = await ctx.ports.sidecar.ensure({ home: ctx.home, waitMs: ctx.sidecarWaitMs });
    if (!ensured.ok) return refused(`SIDECAR_${ensured.reason.toUpperCase()}`);
  }
  const link = request.action === 'link';
  const optional = { ...(request.harness === undefined ? {} : { harness: request.harness }), ...(request.session === undefined ? {} : { session: request.session }) };
  const body = link
    ? { taskId: request.taskId, ...optional, ...(request.replace === true ? { replace: true } : {}), ...(request.via === undefined ? {} : { via: request.via }), channel: 'terminal' }
    : optional;
  const answer = await ctx.ports.sidecar.request({ home: ctx.home, op: link ? 'session.link' : 'session.unlink', workspace: ctx.workspaceRoot, body, scope: 'cli', ...personRequest(ctx) });
  if (!answer.ok) return refused(answer.reasonCode ?? `SIDECAR_${answer.reason.toUpperCase()}`);
  const checked = SessionLinkResultContract.validate(answer.result);
  if (!checked.ok) return refused('SIDECAR_INVALID_RESULT');
  const r: SessionLinkResult = checked.value;
  switch (r.result) {
    case 'linked':
    case 'already-linked':
      return {
        code: COMMAND_EXIT_CODES.ok,
        result: { changed: r.result === 'linked', ...r },
        lines: [
          `${r.result === 'linked' ? 'Linked' : 'Already linked'}: the ${r.harness} session ${shortSession(r.sessionId)} (last seen ${when(r.lastSeenAtMs)} UTC) works on task ${r.taskId}.`,
          'Its main session may now be switched per turn where routing.mainSession and certification allow it. Undo with jevris route --unlink.',
        ],
      };
    case 'ambiguous':
      return {
        code: COMMAND_EXIT_CODES.negative,
        result: { changed: false, ...r },
        lines: ['Not linked: more than one session could be meant. Name one with --session <id>:', ...r.candidates.map((c) => `  ${c.harness} ${c.sessionId} (last seen ${when(c.lastSeenAtMs)} UTC)`)],
      };
    case 'unlinked':
      return { code: COMMAND_EXIT_CODES.ok, result: { changed: true, ...r }, lines: [`Unlinked the ${r.harness} session ${shortSession(r.sessionId)}. Its turns get advice only.`] };
    case 'not-linked':
      return { code: COMMAND_EXIT_CODES.ok, result: { changed: false, ...r }, lines: [`The ${r.harness} session ${shortSession(r.sessionId)} was not linked; nothing changed.`] };
  }
}

/** Checks the --harness and --session values both commands take; a message, or null when fine. */
export function linkFlagProblem(harness: string | undefined, session: string | undefined): string | null {
  if (harness !== undefined && !(HARNESS_IDS as readonly string[]).includes(harness)) return `--harness must be one of ${HARNESS_IDS.join(', ')}.`;
  if (session !== undefined && !SESSION.test(session)) return 'A session id is letters, digits, dots, colons, dashes or underscores.';
  return null;
}

/** Runs `jevris route ... --link` or `jevris route ... --unlink` (argv after `route`). */
export async function runRouteLink(argv: readonly string[], write: Write, options: RouteLinkOptions = {}): Promise<number> {
  const parsed = parse(argv, ['--home', '--workspace', '--task', '--harness', '--session'], ['--link', '--unlink', '--replace', '--json']);
  const json = typeof parsed !== 'string' && parsed.flags.has('--json');
  const usage = (message: string): number => {
    write(json ? `${JSON.stringify({ error: { code: 'USAGE', message } })}\n` : `${message}\nRun jevris route --help for usage.\n`);
    return COMMAND_EXIT_CODES.usage;
  };
  if (typeof parsed === 'string') return usage(parsed);
  if (parsed.positionals.length > 0) return usage(`Unexpected argument "${(parsed.positionals[0] ?? '').slice(0, 40)}".`);
  const link = parsed.flags.has('--link');
  const unlink = parsed.flags.has('--unlink');
  const taskId = parsed.values.get('--task');
  const harness = parsed.values.get('--harness');
  const session = parsed.values.get('--session');
  if (link === unlink) return usage('Use --link or --unlink, not both.');
  if (link && taskId === undefined) return usage('Name the task to link: jevris route --task <id> --link.');
  if (unlink && (taskId !== undefined || parsed.flags.has('--replace'))) return usage('--unlink takes no --task or --replace: jevris route --unlink [--session <id>].');
  if (taskId !== undefined && !TASK.test(taskId)) return usage('A task id is letters, digits, dots, dashes or underscores.');
  const flagProblem = linkFlagProblem(harness, session);
  if (flagProblem !== null) return usage(flagProblem);

  const ctx = contextFor(parsed, options, options.ports ?? (await defaultPorts()));
  const refusedHome = homeRefusal(ctx);
  if (refusedHome !== null) return usage(refusedHome);
  if (ctx.workspaceRoot === null) return usage('Run it inside the repository the session works in, or name it with --workspace.');
  const command = link ? 'route link' : 'route unlink';
  const out = (o: LinkOutcome): number => {
    write(json ? `${JSON.stringify({ schemaVersion: '1.0', command, ...o.result })}\n` : `${o.lines.join('\n')}\n`);
    return o.code;
  };
  // A link needs a person: refused before the sidecar is asked when no terminal is there.
  if (link) {
    const noTerminal = linkTerminalRefusal(ctx.env, options);
    if (noTerminal !== null) return out(noTerminal);
  }
  return out(
    await requestSessionLink(ctx, {
      action: link ? 'link' : 'unlink',
      ...(taskId === undefined ? {} : { taskId }),
      ...(harness === undefined ? {} : { harness }),
      ...(session === undefined ? {} : { session }),
      ...(parsed.flags.has('--replace') ? { replace: true } : {}),
    }),
  );
}
