/**
 * `jevris advise <capability>` (US22; SSOT §12.3 to §12.9): D's orchestration, retrieval, verification
 * and research capabilities through the `capability.advise` op (a local, rules-only answer when the sidecar
 * is down). Each is advice: nothing is started, run, changed or approved, and every guard in the
 * answer is false. The input is the capability's own keys only, checked before any request.
 */
import { readFile } from 'node:fs/promises';
import { ADVISE_CAPABILITIES, ADVISE_CAPABILITY_IDS, COMMAND_EXIT_CODES } from '@jevris/contracts';
import { homeRefusal } from './public/home-guard.js';
import { runOperation } from './public/operations.js';
import { refusalReport } from './public/refusal.js';
import { defaultPorts } from './public/ports.js';
import { renderHuman } from './public/render.js';
import { contextFor, parse, type VerifyAdminOptions } from './verify-admin.js';

type Write = (text: string) => void;

const CAPABILITY_LINES = ADVISE_CAPABILITY_IDS.map((id) => {
  const { title, inputs } = ADVISE_CAPABILITIES[id];
  return `  ${id}  ${title}${inputs.length === 0 ? '' : ` (input: ${inputs.join(', ')})`}`;
}).join('\n');

export const ADVISE_HELP = `Usage: jevris advise <capability> [--task <id>] [--input <json> | --input-file <file>] [--json]

Advice from Jevris's orchestration, retrieval, verification and research capabilities, built
from the task graph, receipts, git and the workspace files. Advice only: nothing is started,
run, changed or approved. A capability that quotes text you give it (an intent, a finding, a
contract) asks Jev about it only when source egress is approved; otherwise the rules answer.

Capabilities:
${CAPABILITY_LINES}

Options:
  --task <id>          The task the advice is for
  --input <json>       A JSON object with the capability's input keys (listed above)
  --input-file <file>  The same JSON object from a file (up to 256 KiB), e.g. for patches
  --home <dir>         Jevris home (default: JEVRIS_HOME, else your home directory)
  --workspace <dir>    Workspace (default: the repository containing the current directory)
  --json               Print one JSON result line

Exit codes: 0 advice printed; 2 usage error or refused input.

Examples:
  jevris advise C41 --input '{"base":"main"}'
  jevris advise C26 --input '{"phase":"verifier"}'
  jevris advise C46 --input '{"checkId":"unit"}'
  jevris advise C34 --input '{"query":"retry on timeout"}'
  jevris advise C72`;

const INPUT_CAP = 262_144;

export async function runAdviseCommand(argv: readonly string[], write: Write, options: VerifyAdminOptions = {}): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    write(`${ADVISE_HELP}\n`);
    return argv.length === 0 ? COMMAND_EXIT_CODES.usage : COMMAND_EXIT_CODES.ok;
  }
  const parsed = parse(argv, ['--home', '--workspace', '--task', '--input', '--input-file'], ['--json']);
  const json = typeof parsed !== 'string' && parsed.flags.has('--json');
  const usage = (message: string): number => {
    write(json ? `${JSON.stringify({ error: { code: 'USAGE', message } })}\n` : `${message}\nRun jevris help advise for usage.\n`);
    return COMMAND_EXIT_CODES.usage;
  };
  if (typeof parsed === 'string') return usage(parsed);
  const id = parsed.positionals[0];
  if (parsed.positionals.length !== 1 || id === undefined || !(ADVISE_CAPABILITY_IDS as readonly string[]).includes(id)) {
    return usage(`Name one capability: ${ADVISE_CAPABILITY_IDS.join(', ')}.`);
  }
  const inline = parsed.values.get('--input');
  const file = parsed.values.get('--input-file');
  if (inline !== undefined && file !== undefined) return usage('Give --input or --input-file, not both.');
  let raw: string | undefined = inline;
  if (file !== undefined) {
    try {
      const bytes = await readFile(file);
      if (bytes.byteLength > INPUT_CAP) return usage(`${file} is larger than 256 KiB.`);
      raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return usage(`Cannot read ${file} as UTF-8 text.`);
    }
  }
  let input: unknown = {};
  if (raw !== undefined) {
    if (raw.length > INPUT_CAP) return usage('--input is larger than 256 KiB.');
    try {
      input = JSON.parse(raw) as unknown;
    } catch {
      return usage('The input is not valid JSON.');
    }
  }

  const ctx = contextFor(parsed, options, options.ports ?? (await defaultPorts()));
  const refusedHome = homeRefusal(ctx);
  if (refusedHome !== null) return usage(refusedHome);
  const outcome = await runOperation(ctx, 'capability.advise', {
    capabilityId: id,
    ...(parsed.values.has('--task') ? { taskId: parsed.values.get('--task') } : {}),
    input,
  });
  if (!outcome.ok) {
    const report = refusalReport(outcome, json);
    if (report === null) return usage(outcome.message);
    write(`${report.line}\n`);
    return report.exitCode;
  }
  write(json ? `${JSON.stringify(outcome.result)}\n` : renderHuman(outcome.result));
  return outcome.exitCode;
}
