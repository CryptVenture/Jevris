/**
 * `jevris delivery <report>` (SSOT §12.8, DLV-01..06): the delivery and team-workflow reports,
 * from D's capabilities through the `capability.advise` op (a local, rules-only answer when the
 * sidecar is down).
 *
 *   pr-readiness  C57: a readiness report assembled from receipts and the task graph
 *   ci-triage     C58: each failing CI receipt routed to source, infrastructure or flaky work
 *   upgrades      C59: lockfile changes ranked by risk, with the checks that cover them
 *   migrations    C60: rehearsal record and destructive statements of the changed migrations
 *   docs-drift    C61: documents that reference changed exports, and the example checks
 *   team-policy   C64: a compatible team configuration; exceptions and restrictions kept
 *
 * Every report is advice. Jevris never opens, merges or comments on a pull request, never
 * changes CI settings, secrets or required checks, never installs a package or runs its
 * scripts, and never runs a migration. Those stay with the user or the organization, under
 * their own permissions. `--body-out` writes the readiness report as a pull-request body the
 * user can hand to their own tool; the file goes only where GOV-11 allows.
 */
import { COMMAND_EXIT_CODES, DELIVERY_REPORTS, DELIVERY_REPORT_NAMES, type DeliveryReport, type SurfacePayloads } from '@jevris/contracts';
import { writeConfinedOutput } from './host-policy.js';
import { homeRefusal } from './public/home-guard.js';
import { runOperation } from './public/operations.js';
import { refusalReport } from './public/refusal.js';
import { defaultPorts } from './public/ports.js';
import { renderHuman } from './public/render.js';
import { contextFor, parse, type VerifyAdminOptions } from './verify-admin.js';

type Write = (text: string) => void;

export const DELIVERY_HELP = `Usage: jevris delivery pr-readiness [--task <id>] [--base <rev>] [--comments <n>] [--body-out <file>] [--json]
       jevris delivery ci-triage [--task <id>] [--json]
       jevris delivery upgrades [--base <rev>] [--json]
       jevris delivery migrations [--base <rev>] [--migrations <file>[,<file>...]] [--compatibility <text>] [--json]
       jevris delivery docs-drift [--base <rev>] [--json]
       jevris delivery team-policy [--json]

Delivery reports for the change in this workspace. Each one is advice built from Jevris's own
records (receipts, the task graph, git and the workspace files):
  pr-readiness  Is the change ready for a pull request? Blockers are mandatory checks without a
                current pass, requirements no check covers, tasks not verified, and review
                comments you report.
  ci-triage     Where to start on each failing CI receipt: the change, the CI infrastructure,
                or a flaky test.
  upgrades      Lockfile changes ranked by risk, with the checks that cover the code using them.
  migrations    Whether the changed migrations have a current rehearsal record, and which
                statements are destructive and need your explicit approval.
  docs-drift    Documents that mention changed exports, and the example checks to run.
  team-policy   A team configuration that fits this repository. Repository exceptions and
                managed restrictions are kept.

Jevris never opens, merges or comments on a pull request, never changes CI settings, secrets or
required checks, never installs a package or runs its scripts, and never runs a migration.
Those actions stay yours or your organization's, under your own permissions.

Options:
  --task <id>             The task the report is for (default: the whole workspace)
  --base <rev>            The revision the change is measured from (default: HEAD)
  --comments <n>          pr-readiness: unresolved review comments you counted
  --body-out <file>       pr-readiness: also write the report as a pull-request body (Markdown)
                          for your own tool, for example gh pr create --body-file <file>
  --migrations <files>    migrations: comma-separated files to check (default: the changed ones)
  --compatibility <text>  migrations: the backward-compatibility contract to keep
  --home <dir>            Jevris home (default: JEVRIS_HOME, else your home directory)
  --workspace <dir>       Workspace (default: the repository containing the current directory)
  --json                  Print one JSON result line

Exit codes: 0 report printed; 1 pr-readiness found the change not ready; 2 usage error or
refused input (a refused --body-out prints its reason code).

Examples:
  jevris delivery pr-readiness --base main
  jevris delivery pr-readiness --base main --comments 2 --body-out pr-body.md
  jevris delivery ci-triage
  jevris delivery migrations --compatibility "old readers keep working for one release"`;

const VALUE_FLAGS = ['--home', '--workspace', '--task', '--base', '--comments', '--body-out', '--migrations', '--compatibility'];
const ONLY: { readonly [flag: string]: readonly DeliveryReport[] } = {
  '--base': ['pr-readiness', 'upgrades', 'migrations', 'docs-drift'],
  '--comments': ['pr-readiness'],
  '--body-out': ['pr-readiness'],
  '--migrations': ['migrations'],
  '--compatibility': ['migrations'],
  '--task': ['pr-readiness', 'ci-triage', 'upgrades', 'migrations', 'docs-drift', 'team-policy'],
};

function isReport(name: string | undefined): name is DeliveryReport {
  return name !== undefined && (DELIVERY_REPORT_NAMES as readonly string[]).includes(name);
}

/** The readiness report as a pull-request body: facts from the report, nothing invented. */
export function pullRequestBody(advice: SurfacePayloads['capability.advise']): string {
  const lines = ['## Readiness (from Jevris)', '', advice.summary, ''];
  if (advice.ranked.length > 0) {
    lines.push('### Blockers', '');
    for (const item of advice.ranked) lines.push(`- ${item.label}: ${item.reason}`);
    lines.push('');
  }
  if (advice.kept.length > 0) lines.push('### Mandatory checks', '', ...advice.kept.map((id) => `- ${id}`), '');
  if (advice.validation.length > 0) lines.push('### Missing evidence', '', ...advice.validation.map((v) => `- ${v}`), '');
  for (const note of advice.notes) lines.push(`_${note}_`);
  return `${lines.join('\n').trimEnd()}\n`;
}

export async function runDeliveryCommand(argv: readonly string[], write: Write, options: VerifyAdminOptions = {}): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    write(`${DELIVERY_HELP}\n`);
    return COMMAND_EXIT_CODES.ok;
  }
  const parsed = parse(argv, VALUE_FLAGS, ['--json']);
  const json = typeof parsed !== 'string' && parsed.flags.has('--json');
  const usage = (message: string): number => {
    write(json ? `${JSON.stringify({ error: { code: 'USAGE', message } })}\n` : `${message}\nRun jevris help delivery for usage.\n`);
    return COMMAND_EXIT_CODES.usage;
  };
  if (typeof parsed === 'string') return usage(parsed);
  const report = parsed.positionals[0];
  if (parsed.positionals.length !== 1 || !isReport(report)) return usage(`Name one report: ${DELIVERY_REPORT_NAMES.join(', ')}.`);
  for (const flag of parsed.values.keys()) {
    const only = ONLY[flag];
    if (only !== undefined && !only.includes(report)) return usage(`${flag} does not apply to ${report}.`);
  }
  const comments = parsed.values.get('--comments');
  if (comments !== undefined && !/^\d{1,6}$/.test(comments)) return usage('--comments needs a whole number.');
  const migrations = parsed.values.get('--migrations');
  const input = {
    ...(parsed.values.has('--base') ? { base: parsed.values.get('--base') } : {}),
    ...(comments !== undefined ? { unresolvedComments: Number(comments) } : {}),
    ...(migrations !== undefined ? { migrations: migrations.split(',').map((file) => file.trim()) } : {}),
    ...(parsed.values.has('--compatibility') ? { compatibility: parsed.values.get('--compatibility') } : {}),
  };

  const ctx = contextFor(parsed, options, options.ports ?? (await defaultPorts()));
  const refusedHome = homeRefusal(ctx);
  if (refusedHome !== null) return usage(refusedHome);
  const outcome = await runOperation(ctx, 'capability.advise', {
    capabilityId: DELIVERY_REPORTS[report],
    ...(parsed.values.has('--task') ? { taskId: parsed.values.get('--task') } : {}),
    input,
  });
  if (!outcome.ok) {
    const report = refusalReport(outcome, json);
    if (report === null) return usage(outcome.message);
    write(`${report.line}\n`);
    return report.exitCode;
  }
  const advice = outcome.result.result as SurfacePayloads['capability.advise'];

  let bodyLine: string | null = null;
  const bodyOut = parsed.values.get('--body-out');
  if (bodyOut !== undefined) {
    const written = await writeConfinedOutput(bodyOut, pullRequestBody(advice), { cwd: options.cwd ?? process.cwd(), jevrisHome: ctx.home });
    if (!written.ok) {
      write(json ? `${JSON.stringify({ error: { code: written.reasonCode, message: `--body-out was refused (${written.reasonCode}); nothing was written.` } })}\n` : `refused: ${written.reasonCode}\n`);
      return COMMAND_EXIT_CODES.usage;
    }
    bodyLine = `pull-request body: ${written.path} (open the pull request yourself with it)`;
  }
  if (json) write(`${JSON.stringify(outcome.result)}\n`);
  else write(`${renderHuman(outcome.result)}${bodyLine === null ? '' : `${bodyLine}\n`}`);
  return outcome.exitCode;
}
