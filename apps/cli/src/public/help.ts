/**
 * Top-level usage, per-command help and the version line (ADM-01, §4.4). Admin commands take
 * their help text from F's admin CLI.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageRoot } from '@jevris/platform';

const USAGE = `Usage: jevris <command> [options]

Public commands (also available as skills and MCP tools inside your coding harness):
  status       Mode, sidecar state, recent decisions, budget and kill switch
  plan         Validate a task graph; show waves, critical path and ready tasks
  route        Main-session and worker model advice (never switches a model)
  checkpoint   Save a memory capsule of constraints and changed files (never compacts)
  recover      Recovery advice from repeated or environment failures
  verify       Run approved checks and report readiness; approve, waive, import CI receipts
  explain      Explain one decision: outcome, reasons, model, usage, uncertainty
  configure    Show or change product settings (never native permissions)
  evidence     get <handle>: one evidence item, bounded and redacted
  task         reconcile <task-id> --applied|--abandoned: settle a held owned effect; cancel <task-id>
  cost-report  What Jevris's decision calls cost: actual, API-equivalent estimate, counterfactual
  feedback     Your feedback on one decision's advice: accepted, or rejected with a reason
  delivery     pr-readiness | ci-triage | upgrades | migrations | docs-drift | team-policy reports
  integrate    Integrate verified owned tasks; approve to fast-forward your checkout (never pushes)
  advise       Orchestration and research advice by capability id (C25-C72): test impact, repository evidence, tool preflight...
  budget       status <budget-id>: use and last exhaustion; update: raise (authorized) or resume
  control      Multi-host leases: status, migrate this workspace to a control service, serve one
  handoff      import <capsule.json> [--link]: import a handoff capsule; --link links its task's session

Administration:
  install      Install Jevris into a coding harness (--harness claude|codex|kilo|opencode|antigravity)
  uninstall    Remove Jevris from a harness; your other settings are kept
  doctor       Capability report for this machine and each harness
  certify      Run the conformance checks against a real harness and write a certification
  sidecar      start | stop | restart | status | statusline | metrics | diagnose of the local Jevris service
  service      install | uninstall | status: run the sidecar as a per-user service
  kill-switch  status | activate | clear | drill: stop every Jevris effect at once
  store        status | backup | export | restore | migrate | adopt the local Jevris database
  audit        export | verify the hash-chained audit log
  authorize    Mint a single-use authorization for one guarded action
  credential   set | clear | status of the Jev key in the OS keychain; reenable Jev after a billing refusal
  egress       status | approve | revoke: whether decision fields may be sent to Jev
  consent      provider [<id>] [--grant | --revoke]: which model providers Jevris may route to
  data         purge (expired data) | delete (all Jevris data on this machine)
  pack         list | inspect | install | test | shadow | approve | canary | promote | rollback of policy packs
  policy, gates, shadow, shortlist   Operator tools; see jevris help <command>

Global options:
  --home <dir>   Jevris home (default: JEVRIS_HOME, else your home directory)
  --json         Print the result as JSON (public commands)
  --no-color     Plain output with no colour or logo on a terminal (as NO_COLOR=1 does)
  -h, --help     Show help; jevris help <command> shows one command
  --version      Print the Jevris version

Exit codes: 0 answered; 1 a negative answer (not found, not verified, invalid plan);
2 a usage error or a refused request.
`;

export async function topLevelUsage(): Promise<string> {
  return USAGE;
}

/**
 * Help for an administration command: F's `helpText` from admin-cli.ts, the only source. cli.ts
 * passes it in (a static import there keeps the bundle closed).
 */
export async function helpFor(command: string, adminHelp: (command: string) => string | null | undefined): Promise<string | null> {
  try {
    const text = adminHelp(command);
    return typeof text === 'string' && text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

let cachedVersion: string | undefined;

export function jevrisVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as { version?: unknown };
    cachedVersion = typeof pkg.version === 'string' && /^\d+\.\d+\.\d+/.test(pkg.version) ? pkg.version : '0.0.0';
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}

export function versionText(): string {
  return `jevris ${jevrisVersion()}`;
}

const STDIN_CAP = 1_048_577;

/** Reads standard input up to 1 MiB plus one byte (the caller refuses anything larger). */
export async function readAllStdin(): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of process.stdin) {
      const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
      chunks.push(bytes);
      total += bytes.byteLength;
      if (total >= STDIN_CAP) break;
    }
  } catch {
    return new Uint8Array();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
