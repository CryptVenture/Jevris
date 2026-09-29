/**
 * `jevris handoff import <capsule.json> [--link ...]` (owner decision 29423b6; coordinator's
 * approval). The same `handoff.import` operation as the MCP tool jevris_handoff_import, on the CLI
 * key, and one more thing only a person at a terminal can ask for: `--link` links the session
 * working on the imported task to that task, through the shared route-link code (B's
 * session.link), so its main session may be switched per turn.
 *
 * - The link is checked before the import: with no interactive terminal nothing is imported and
 *   nothing is linked. MCP's handoff import never links.
 * - The task is the capsule's own: its single task id, or the one --task names from its list.
 * - An import never grants authority (§9.5); the link is a separate, audited step by the sidecar.
 */
import { readFile } from 'node:fs/promises';
import { COMMAND_EXIT_CODES, ID_PATTERN } from '@jevris/contracts';
import { createSurfaceContext } from './public/context.js';
import { homeRefusal } from './public/home-guard.js';
import { runOperation } from './public/operations.js';
import { defaultPorts } from './public/ports.js';
import { renderHuman } from './public/render.js';
import { linkFlagProblem, linkTerminalRefusal, requestSessionLink, type LinkOutcome, type RouteLinkOptions } from './route-link.js';
import { parse } from './verify-admin.js';

type Write = (chunk: string) => void;

const CAPSULE_CAP = 1_048_576;
const TASK = new RegExp(ID_PATTERN);

/** B's session.link takes `via: 'handoff'` from the terminal (dd06675), so a link made here says where it came from. */
export const HANDOFF_LINK_VIA_SUPPORTED = true;

export const HANDOFF_HELP = `Usage: jevris handoff import <capsule.json> [--home <dir>] [--workspace <dir>] [--json]
       jevris handoff import <capsule.json> --link [--task <id>] [--harness <id>] [--session <id>] [--replace] [--json]

Imports a handoff capsule another session exported (the jevris_handoff_export tool): its facts,
evidence references and open items, negotiated for this workspace. An import never grants
authority: expired approvals stay history. The same import as the jevris_handoff_import tool.

--link    After the import, links the session working on the capsule's task to that task,
          so its Kilo or OpenCode main session may be switched per turn (routing.md). It needs
          a person at an interactive terminal: without one, nothing is imported or linked.
          Jevris finds the session in its own records, as jevris route --task <id> --link
          does, and lists the sessions when more than one could be meant. The MCP tool never
          links.

Options:
  --link             Link the session to the capsule's task after the import
  --task <id>        Which of the capsule's tasks to link, when it names more than one
  --harness <id>     The harness the session runs in (default: any Kilo or OpenCode session)
  --session <id>     The session id, when more than one could be meant
  --replace          Move a session already linked to another task
  --home <dir>       Jevris home (default: JEVRIS_HOME, else your home directory)
  --workspace <dir>  Workspace (default: the repository containing the current directory)
  --json             Print one JSON result line: { import, link }

Exit codes: 0 imported (and linked, with --link); 1 the capsule was not accepted, or the link
was refused or ambiguous; 2 usage error, an unreadable capsule, or no interactive terminal
for --link.

Examples:
  jevris handoff import capsule.json
  jevris handoff import capsule.json --link --harness kilocode`;

async function readCapsule(path: string): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly message: string }> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch {
    return { ok: false, message: `Cannot read ${path.slice(0, 200)}.` };
  }
  if (bytes.byteLength > CAPSULE_CAP) return { ok: false, message: 'The capsule is larger than 1 MiB.' };
  try {
    return { ok: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown };
  } catch {
    return { ok: false, message: 'The capsule is not valid UTF-8 JSON.' };
  }
}

/** The capsule's task ids, as far as they are plain ids (the import checks the rest). */
function capsuleTaskIds(value: unknown): readonly string[] {
  // A portable v2 envelope carries the capsule inside it; a bare v1 capsule is the capsule.
  const inner = value !== null && typeof value === 'object' ? Reflect.get(value, 'capsule') : undefined;
  const capsule = inner !== null && typeof inner === 'object' ? inner : value;
  const ids = capsule !== null && typeof capsule === 'object' ? Reflect.get(capsule, 'taskIds') : undefined;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && TASK.test(id)).slice(0, 64) : [];
}

/** Runs `jevris handoff ...` (argv after `handoff`). */
export async function runHandoffCommand(argv: readonly string[], write: Write, options: RouteLinkOptions = {}): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    write(`${HANDOFF_HELP}\n`);
    return argv.length === 0 ? COMMAND_EXIT_CODES.usage : COMMAND_EXIT_CODES.ok;
  }
  const parsed = parse(argv, ['--home', '--workspace', '--task', '--harness', '--session'], ['--link', '--replace', '--json']);
  const json = typeof parsed !== 'string' && parsed.flags.has('--json');
  const usage = (message: string): number => {
    write(json ? `${JSON.stringify({ error: { code: 'USAGE', message } })}\n` : `${message}\nRun jevris help handoff for usage.\n`);
    return COMMAND_EXIT_CODES.usage;
  };
  if (typeof parsed === 'string') return usage(parsed);
  if (parsed.positionals[0] !== 'import') return usage('Only import is a handoff command here: jevris handoff import <capsule.json>.');
  if (parsed.positionals.length !== 2) return usage('Give exactly one capsule file: jevris handoff import <capsule.json>.');
  const link = parsed.flags.has('--link');
  const taskFlag = parsed.values.get('--task');
  const harness = parsed.values.get('--harness');
  const session = parsed.values.get('--session');
  if (!link && (taskFlag !== undefined || harness !== undefined || session !== undefined || parsed.flags.has('--replace'))) {
    return usage('--task, --harness, --session and --replace go with --link.');
  }
  const flagProblem = linkFlagProblem(harness, session);
  if (flagProblem !== null) return usage(flagProblem);
  const read = await readCapsule(parsed.positionals[1] ?? '');
  if (!read.ok) return usage(read.message);

  const ctx = createSurfaceContext({
    home: parsed.values.get('--home'),
    workspace: parsed.values.get('--workspace'),
    scope: 'cli',
    ports: options.ports ?? (await defaultPorts()),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
  });
  const refusedHome = homeRefusal(ctx);
  if (refusedHome !== null) return usage(refusedHome);

  // Everything --link needs is settled before the import, so a refusal leaves nothing half done.
  let taskId: string | undefined;
  if (link) {
    const noTerminal = linkTerminalRefusal(ctx.env, options);
    if (noTerminal !== null) {
      write(json ? `${JSON.stringify({ schemaVersion: '1.0', command: 'handoff import', import: null, link: noTerminal.result })}\n` : `Nothing was imported. ${noTerminal.lines.join(' ')}\n`);
      return noTerminal.code;
    }
    if (ctx.workspaceRoot === null) return usage('Run it inside the repository the session works in, or name it with --workspace.');
    const ids = capsuleTaskIds(read.value);
    if (taskFlag !== undefined) {
      if (!ids.includes(taskFlag)) return usage(`The capsule names no task ${taskFlag.slice(0, 64)}${ids.length === 0 ? '' : `; it names ${ids.join(', ')}`}.`);
      taskId = taskFlag;
    } else if (ids.length === 1) {
      taskId = ids[0];
    } else {
      return usage(ids.length === 0 ? 'The capsule names no task, so there is nothing to link.' : `The capsule names ${ids.length} tasks; choose one with --task: ${ids.join(', ')}.`);
    }
  }

  const outcome = await runOperation(ctx, 'handoff.import', { capsule: read.value });
  if (!outcome.ok) {
    const code = outcome.exitCode === COMMAND_EXIT_CODES.negative ? COMMAND_EXIT_CODES.negative : COMMAND_EXIT_CODES.usage;
    write(json ? `${JSON.stringify({ error: { code: outcome.reasonCode ?? 'REFUSED', message: outcome.message } })}\n` : `${outcome.message}${outcome.reasonCode === undefined ? '' : ` (${outcome.reasonCode})`}\n`);
    return code;
  }
  const imported = outcome.result;
  const accepted = (imported.result as { readonly accepted?: unknown }).accepted === true;
  let linked: LinkOutcome | null = null;
  if (link && taskId !== undefined) {
    linked = accepted
      ? await requestSessionLink(ctx, {
          action: 'link',
          taskId,
          ...(harness === undefined ? {} : { harness }),
          ...(session === undefined ? {} : { session }),
          ...(parsed.flags.has('--replace') ? { replace: true } : {}),
          ...(HANDOFF_LINK_VIA_SUPPORTED ? { via: 'handoff' as const } : {}),
        })
      : { code: COMMAND_EXIT_CODES.negative, result: { changed: false, reasonCode: 'HANDOFF_NOT_ACCEPTED' }, lines: ['Not linked: the capsule was not accepted.'] };
  }
  const code = !accepted ? COMMAND_EXIT_CODES.negative : linked === null ? COMMAND_EXIT_CODES.ok : linked.code;
  if (json) {
    write(`${JSON.stringify({ schemaVersion: '1.0', command: 'handoff import', import: imported, link: linked === null ? null : linked.result })}\n`);
  } else {
    write(renderHuman(imported));
    if (linked !== null) write(`${linked.lines.join('\n')}\n`);
  }
  return code;
}
