/**
 * The eight public commands (§11.2): status, plan, route, checkpoint, recover, verify, explain,
 * configure. Each does real work through the sidecar (B), the engine (C) and orchestration
 * (D), and answers in a precise reduced mode from local state when the sidecar is down.
 *
 * `--json` prints the result contract (packages/contracts/src/commands.ts); without it the
 * same result is rendered as plain text. Exit codes: 0 answered, 1 negative answer, 2 usage.
 *
 * `jevris __surface <operation>` is the internal entry the MCP server uses: the arguments
 * arrive as one JSON object on stdin (never argv), the scope is `mcp`, and the result JSON is
 * printed on one line.
 */
import { readFile } from 'node:fs/promises';
import { providerOverrideDiagnostic } from '@jevris/provider-typesafe';
import { COMMAND_EXIT_CODES, isSurfaceOperation, PUBLIC_COMMAND_NAMES, type PublicCommandName } from '@jevris/contracts';
import { loadModelRegistry } from '@jevris/core';
import { SETTABLE_KEYS, raisePrompt, raiseWhat, raisesAuthority } from '@jevris/orchestrator';
import type { NativeProbe } from '@jevris/platform';
import { resultDataTermsLine } from './data-terms.js';
import { createSurfaceContext } from './public/context.js';
import { runOperation } from './public/operations.js';
import { refusalReport } from './public/refusal.js';
import { defaultPorts, type SurfacePorts } from './public/ports.js';
import { renderHuman } from './public/render.js';
import { ROUTE_LEARNING_HELP } from './route-learning-help.js';
import { ROUTE_LIMITS_HELP } from './route-limits-help.js';

export type Write = (text: string) => void;

export function isPublicCommand(name: string): name is PublicCommandName {
  return (PUBLIC_COMMAND_NAMES as readonly string[]).includes(name);
}

interface FlagSpec {
  readonly value: readonly string[];
  readonly repeat: readonly string[];
  readonly boolean: readonly string[];
}

const COMMON: FlagSpec = { value: ['--home', '--workspace'], repeat: [], boolean: ['--json'] };

const FLAGS: { readonly [K in PublicCommandName]: FlagSpec } = {
  status: COMMON,
  explain: { value: [...COMMON.value, '--slice'], repeat: [], boolean: COMMON.boolean },
  route: {
    value: [...COMMON.value, '--model', '--pin', '--effort-pin', '--task', '--slice', '--remaining-input', '--remaining-output', '--context-tokens', '--warm-prefix', '--auth-mode', '--harness'],
    repeat: [],
    boolean: [...COMMON.boolean, '--cold-cache', '--mid-step'],
  },
  plan: { value: [...COMMON.value, '--graph'], repeat: [], boolean: COMMON.boolean },
  checkpoint: { value: [...COMMON.value, '--objective', '--task'], repeat: ['--constraint'], boolean: COMMON.boolean },
  recover: { value: [...COMMON.value, '--task'], repeat: ['--failure', '--env-failure', '--rejected'], boolean: COMMON.boolean },
  verify: { value: [...COMMON.value, '--task'], repeat: ['--check'], boolean: COMMON.boolean },
  configure: { value: COMMON.value, repeat: [], boolean: [...COMMON.boolean, '--dry-run', '--yes'] },
};

/** D's settable keys (`SETTABLE_KEYS`), wrapped for the configure help: the one list set checks against. */
function settableKeysText(): string {
  const lines: string[] = [];
  let current = ' ';
  for (const key of Object.keys(SETTABLE_KEYS)) {
    const next = `${current} ${key}`;
    if (next.length > 92 && current.trim() !== '') {
      lines.push(current);
      current = `  ${key}`;
    } else current = next;
  }
  lines.push(current);
  return lines.join('\n');
}

export const PUBLIC_HELP: { readonly [K in PublicCommandName]: string } = {
  status: `Usage: jevris status [--json] [--home <dir>] [--workspace <dir>]

Shows the Jevris mode, sidecar state and any degraded reason, recent decisions, budget,
kill switch and unevaluated slices. With the sidecar running it also shows the last 7 days of
deadline misses (hooks that answered late or without the sidecar, late sidecar answers, slow
subscribers) against the 900 ms target, and how many Stop reminders fired and what followed
them (a check, verification, or an unverified end), and its queues: hook and background
requests in flight, and background work running, held, waiting or spooled to disk. It names
the model registry routing reads: the bundled snapshot, an administrator's override, or an
override refused (MODEL_REGISTRY_TOO_LARGE, _NOT_JSON, _INVALID or _UNREADABLE), which leaves
routing unavailable. When the sidecar is down the answer is a reduced local report that says so; the sidecar starts on demand unless
JEVRIS_SIDECAR_AUTOSTART=0.

Options:
  (no command options)
  --home <dir>        Jevris home (default: JEVRIS_HOME, else your home directory)
  --workspace <dir>   Workspace (default: the repository containing the current directory)
  --json              Print one JSON result line (the command's contract)

Exit codes: 0 answered (full or reduced); 1 is not used; 2 usage error or refused input.

Examples:
  jevris status
  jevris status --json`,
  explain: `Usage: jevris explain <decision-id> [--slice <id>] [--json]

Shows a factual trace of one decision: outcome, reason codes, resolved model, usage and
uncertainty. It never shows a secret or raw source.

Options:
  <decision-id>       The decision to explain (from jevris status)
  --slice <id>        Also show that task slice's route learning: active, advice only or pinned,
                      the policy version, the signed baseline prior and the local outcomes
                      apart, and why (see jevris route learning status)
  --home <dir>        Jevris home (default: JEVRIS_HOME, else your home directory)
  --workspace <dir>   Workspace (default: the repository containing the current directory)
  --json              Print one JSON result line (the command's contract)

Exit codes: 0 answered (full or reduced); 1 the decision is not found; 2 usage error or refused input.

Examples:
  jevris explain dec-4f2a
  jevris explain dec-4f2a --json
  jevris explain dec-4f2a --slice bounded-edit`,
  route: `Usage: jevris route [--model <current-model>] [--pin <pinned-model>] [--effort-pin <effort>] [--task <id>] [--slice <id>]
                    [--harness <id>] [--auth-mode <mode>]
                    [--remaining-input <tokens> --remaining-output <tokens>] [--context-tokens <tokens>]
                    [--warm-prefix <tokens> [--cold-cache] [--mid-step]] [--json]
       jevris route --task <id> --link [--harness <id>] [--session <id>] [--replace] [--json]
       jevris route --unlink [--harness <id>] [--session <id>] [--json]

Advice for the main session and for managed workers. Jevris never switches a model and never
overrides a pinned one; applied is always false. A switch of the main session is priced with
the cost of moving its warm prefix to the new model: without --warm-prefix that cost is unknown
and the advice keeps the current model.

Options:
  --model <id>        The model the session uses now, as the harness names it: a model id,
                      provider/model (Kilo, OpenCode) or with [1m] (default: unknown). A model
                      outside the model registry gets no advice to switch (it abstains)
  --pin <id>          A model you pinned, in the same forms; it is always kept
  --effort-pin <e>    An effort level you pinned
  --task <id>         The task the advice is for
  --slice <id>        The task's slice (such as bounded-edit), so a released calibration for
                      it can apply to managed-worker advice (default: unknown, no worker advice)
  --remaining-input <n>   Input tokens the rest of the task needs; give it with
  --remaining-output <n>  output tokens (default: the routing policy's task size)
  --context-tokens <n>    Context the task needs, in tokens
  --warm-prefix <n>       Tokens of the session's cached prompt prefix a switch would move
  --cold-cache            The prefix cache is cold (default: warm)
  --mid-step              The session is inside a step, not at a boundary: never switch now
  --harness <id>          The harness the session runs in: claude, kilocode, codex, opencode or
                          antigravity. Advice then names only models that harness can run with
                          that sign-in (default: not scoped)
  --auth-mode <mode>      How the session's harness is billed: api-key, subscription or unknown
                          (default: unknown). It scopes the advice with --harness, and labels the
                          transition cost: list price on an API key, an API-equivalent estimate
                          of usage-limit use on a subscription
  --home <dir>        Jevris home (default: JEVRIS_HOME, else your home directory)
  --workspace <dir>   Workspace (default: the repository containing the current directory)
  --json              Print one JSON result line (the command's contract)

Linking the session you work in to its task (--link, --unlink):
  A Kilo or OpenCode main session is switched per turn only when it is linked to its task;
  otherwise it gets advice only. --link needs a person at an interactive terminal (never MCP,
  a hook, a pipe or a model's shell). Jevris finds the session in its own records: the one
  active session of that harness seen in the last few minutes in this workspace, or the one
  --session names exactly. When more than one could be meant it lists them and links none.
  The answer names the session it linked, and jevris status shows every link.
  --link              Link the session to the task given with --task
  --replace           With --link: move a session already linked to another task
  --session <id>      The session id, when more than one could be meant
  --unlink            Remove the session's link (works anywhere; it only takes authority away)
  For example, in a terminal next to the Kilo session:
    jevris route --task fix-parser --link --harness kilocode
    jevris route --unlink --harness kilocode

Exit codes: 0 answered (full or reduced); 1 is not used; 2 usage error or refused input.
With --link or --unlink: 0 linked, unlinked or unchanged; 1 not linked (refused or more than
one session could be meant); 2 usage error or no interactive terminal.

Examples:
  jevris route --model claude-opus-5-5
  jevris route --model claude-opus-5-5 --pin claude-opus-5-5 --effort-pin high --json
  jevris route --task fix-parser --slice bounded-edit
  jevris route --model anthropic/claude-opus-5-5 --harness opencode --auth-mode subscription
  jevris route --model claude-opus-5-5 --slice bounded-edit --remaining-input 100000 --remaining-output 10000 --warm-prefix 150000

Learning (jevris route learning --help):

${ROUTE_LEARNING_HELP}

Access limits (jevris route limits --help):

${ROUTE_LIMITS_HELP}`,
  plan: `Usage: jevris plan --graph <tasks.json> [--json]
       jevris plan --submit --graph <tasks.json> --budget <id> --limit-micro-usd <n>
                   [--reserve-micro-usd <n>] [--budget-policy <policy>] [--owner <id>]
                   [--authorization <id>] [--yes] [--json]

Validates a task graph (a JSON list of TaskNode objects): cycles, unknown dependencies,
missing acceptance checks and requirements, and parallel tasks that share a write scope.
Prints waves, the critical path and the tasks that are ready. Only each task's TaskNode fields
are checked: the scheduling fields --submit reads (title, models, expectedOutputs and so on)
are allowed in the file and ignored by this check. With --submit, expectedOutputs are names
(letters, digits, . _ : -), not file paths: an entry with a slash is refused, naming the field.

With --submit, hands the plan to the Jevris sidecar as owned work under a new root budget and
prints the plan id, the budget id and the task ids. Only the CLI can submit a plan; no model
tool can. It commits a spending limit and may start owned workers (in bounded-auto mode, for
tasks that name a model), so it asks for confirmation or needs --yes. A new root budget also
needs a person: answer y at an interactive terminal (without --yes or --json), or mint an
authorization in a terminal first (jevris authorize budget.increase --scope <budget-id>) and
pass --authorization <id>. Otherwise the sidecar refuses it (CHANNEL_REFUSED) and nothing is
created. A plan under a budget that already exists here needs neither. Every acceptance check a
task names must be an approved check (jevris verify approve). In owned mode, MCP clients can
then add tasks under the returned budget id.

Options:
  --graph <file>             JSON file with the task list, or { tasks, requirementIds?,
                             availableResources? } (required; at most 1 MiB)
  --submit                   Submit the plan instead of only checking it
  --budget <id>              submit: the root budget id (required). Reusing an id needs the
                             budget's current limit (after jevris budget update, the raised
                             one) and the same owner. A reserve or policy you name must match
                             the recorded one; one you leave out keeps the recorded value.
  --limit-micro-usd <n>      submit: the spending limit in micro-USD, 1 USD = 1000000 (required)
  --reserve-micro-usd <n>    submit: kept back for shutdown, below the limit (default 5% of the
                             limit for a new budget)
  --budget-policy <policy>   submit: finish-running, cancel-newest or pause-all when the
                             budget runs out
  --owner <id>               submit: the plan owner (default: your user name)
  --authorization <id>       submit: the id jevris authorize printed for budget.increase on
                             this budget id; lets a new root budget be created with --yes
  --yes                      submit: confirm without the terminal question
  --home <dir>               Jevris home (default: JEVRIS_HOME, else your home directory)
  --workspace <dir>          Workspace (default: the repository containing the current directory)
  --json                     Print one JSON result line (the command's contract)

Exit codes: 0 answered, or submitted; 1 the plan is invalid, or was not submitted (the reason
code says why); 2 usage error or refused input, or not confirmed, including a new root budget
no person confirmed (CHANNEL_REFUSED, AUTHORIZATION_REFUSED).

Examples:
  jevris plan --graph tasks.json
  jevris plan --graph tasks.json --json
  jevris plan --submit --graph tasks.json --budget sprint-1 --limit-micro-usd 5000000
  jevris plan --submit --graph tasks.json --budget sprint-1 --limit-micro-usd 5000000 --authorization auth-0123 --yes`,
  checkpoint: `Usage: jevris checkpoint [--objective <text>] [--constraint <text>]... [--task <id>] [--json]

Writes a memory capsule (objective, constraints, changed-file hashes) under the Jevris data
directory and prints what it kept. It never triggers compaction.

Options:
  --objective <text>  The current objective (default: none)
  --constraint <text> A constraint to keep; repeat for more
  --task <id>         The task the capsule belongs to
  --home <dir>        Jevris home (default: JEVRIS_HOME, else your home directory)
  --workspace <dir>   Workspace (default: the repository containing the current directory)
  --json              Print one JSON result line (the command's contract)

Exit codes: 0 answered (full or reduced); 1 is not used; 2 usage error or refused input.

Examples:
  jevris checkpoint --objective "Ship the parser" --constraint "No new dependencies"`,
  recover: `Usage: jevris recover [--failure <fingerprint>]... [--env-failure <fingerprint>]... [--rejected <approach>]... [--task <id>] [--json]

Classifies failure signals (repeats, oscillation, environment failures) and names one
recovery action from the allowlist. Nothing is retried or changed.

A repeat is the same failure seen at least twice; one failure is never a repeat.
Oscillation is two failures taking turns, at least four in a row (A, B, A, B), in the
order given. Its action is to restore the last checkpoint with your approval, and a used-up
repair budget does not replace that with a stop, because nothing is restored without you.

Options:
  --failure <text>    A failure fingerprint, in the order it happened; repeat
  --env-failure <t>   A failure caused by the environment (missing service or tool); repeat
  --rejected <text>   An approach not to repeat; repeat
  --task <id>         The task the failures belong to
  --home <dir>        Jevris home (default: JEVRIS_HOME, else your home directory)
  --workspace <dir>   Workspace (default: the repository containing the current directory)
  --json              Print one JSON result line (the command's contract)

Exit codes: 0 answered (full or reduced); 1 is not used; 2 usage error or refused input.

Examples:
  jevris recover --failure 'TypeError at parse.ts:40' --failure 'TypeError at parse.ts:40'
  jevris recover --env-failure 'ECONNREFUSED 5432' --json`,
  verify: `Usage: jevris verify [--check <id>]... [--task <id>] [--json]
       jevris verify profile [--json]
       jevris verify approve [--proposal]
       jevris verify revoke [<check-id>...] [--yes] [--json]
       jevris verify required <check-id>... [--json]
       jevris verify waive <check-id> --reason <text> [--authority <name>]
       jevris verify issuer add <issuer-id> --key <public-key.pem> [--key-id <id>] [--repository <owner/name>]
       jevris verify issuer remove <issuer-id> [--yes]
       jevris verify issuer list [--json]
       jevris verify import-ci <bundle.json> --artifacts <dir> [--json]

verify runs the approved checks through the verification runner and reports receipts and
completion readiness. Only a current passing receipt counts; nothing is marked passed by hand.
A long check keeps running after verify answers: its line then says it is still running in
the background, or queued behind the run under way; run jevris verify again later to read the
result. If the sidecar takes the request but does not answer in time, verify says the state
of the checks is unknown (VERIFY_STATE_UNKNOWN, exit 1), never that nothing ran: run it again
to see them; it joins the run under way. A check id that is not approved is refused
(UNKNOWN_CHECK, exit 2), and nothing runs.

  profile     Propose checks for this workspace from its languages and tools. Writes nothing.
  approve     Approve the checks in jevris.checks.json (or .jevris/checks.json); with
              --proposal, approve the profiled proposal. An edited check needs approval again.
  revoke      Withdraw approval of the named checks (default: all).
  required    Show each named check as passed, failed, missing or waived, in the order named
              (a repeated id is shown once).
  waive       Record a named person's waiver for one check. A waiver is never a pass.
  issuer      Trust (add), stop trusting (remove) or list CI issuers whose signed receipts
              import-ci accepts. The key must be an Ed25519 public key (PEM, SPKI).
  import-ci   Import a signed CI receipt bundle with its artifacts through the sidecar.

approve, revoke, waive and issuer add/remove change what counts as verified. approve, waive
and issuer add widen it, so they need a person at an interactive terminal who answers y:
--yes, --json, a pipe or a script is refused (CHANNEL_REFUSED) and nothing changes. revoke and
issuer remove only narrow it: they ask on a terminal, or take --yes. All of them are CLI-only;
no MCP tool or hook can call them.

Options:
  --check <id>        A check to run; repeat (default: the task's acceptance checks)
  --task <id>         The task whose checks to run
  --proposal          approve: approve the profiled proposal instead of jevris.checks.json
  --yes               revoke, issuer remove: confirm without the terminal question
  --reason <text>     waive: why the check is waived (required)
  --authority <name>  waive: who authorizes the waiver (default: your user name; --by is
                      accepted as the same option)
  --key <file>        issuer add: the issuer's Ed25519 public key in PEM form
  --key-id <id>       issuer add: the key id the bundles name (default: default)
  --repository <o/n>  issuer add: accept bundles only for this repository
  --artifacts <dir>   import-ci: the directory holding the bundle's artifacts (at most 8 MiB)
  --home <dir>        Jevris home (default: JEVRIS_HOME, else your home directory)
  --workspace <dir>   Workspace (default: the repository containing the current directory)
  --json              Print one JSON result line (the command's contract)

Exit codes: 0 verified, approved, imported or listed; 1 not verified, state unknown (the
sidecar answered late), nothing to approve, nothing revoked or a refused bundle; 2 usage error, refused input, or a change that was
not confirmed.

Examples:
  jevris verify profile
  jevris verify approve
  jevris verify --check unit --check lint
  jevris verify required unit lint
  jevris verify waive e2e --reason "No browser on this runner" --authority alice
  jevris verify issuer add github-ci --key ci.pub.pem --repository acme/app
  jevris verify import-ci bundle.json --artifacts ./artifacts`,
  configure: `Usage: jevris configure [show] [--json]
       jevris configure set <key> <value> [--dry-run] [--yes] [--json]
       jevris configure owned-mode [on|off] [--workspace <dir>] [--json]
       jevris configure workspace-budget [<micro-usd>|none] [--dry-run] [--workspace <dir>] [--json]

Shows the effective configuration or changes one product setting. It never changes
native harness permissions; source egress needs administrator approval.

Settable keys (docs/settings.md gives each one's values):
${settableKeysText()}

Options:
  show                Print the effective settings and their sources (the default)
  set <key> <value>   Change one product setting
  --dry-run           set: show the change without writing it
  owned-mode [on|off] Show, or turn on or off, owned mode for the workspace: when on, MCP
                      clients of that workspace may submit owned work (task.submit only).
                      Turning it on needs a person at an interactive terminal who answers
                      y; --yes, --json and a pipe are refused (CHANNEL_REFUSED). No
                      environment variable turns it on.
  workspace-budget [<micro-usd>|none]
                      Show, set or remove this workspace's own monthly cap on Jev decision
                      calls, in whole micro-USD (1 USD is 1000000), inside the machine-wide
                      limit decisions.monthlyBudgetMicroUsd. 0 means no Jev calls here
                      (rules-only). A first cap and a lower one need nothing; a higher cap
                      or none needs a person at an interactive terminal who answers y.
  --yes               Never confirms a raise. Raising mode, routing.managedWorkers,
                      routing.mainSession, verification.backgroundAtStop or
                      decisions.monthlyBudgetMicroUsd above its
                      effective value needs a person at an interactive terminal who answers
                      y; --yes, --json and a pipe are refused (CHANNEL_REFUSED). Lowering and
                      the same value need nothing.
  --home <dir>        Jevris home (default: JEVRIS_HOME, else your home directory)
  --workspace <dir>   Workspace (default: the repository containing the current directory)
  --json              Print one JSON result line (the command's contract)

Exit codes: 0 answered (full or reduced); 1 the settings file is not valid; 2 usage error or refused input.

Examples:
  jevris configure
  jevris configure set mode advise --dry-run
  jevris configure set mode advise
  jevris configure set routing.mainSession advice-only
  jevris configure set decisions.monthlyBudgetMicroUsd 2000000
  jevris configure owned-mode on --workspace ~/src/app
  jevris configure workspace-budget 500000 --workspace ~/src/app`,
};

export const EVIDENCE_HELP = `Usage: jevris evidence get <handle> [--selection <id>] [--json] [--home <dir>] [--workspace <dir>]

Prints one evidence item by handle (as listed by the evidence selection or a receipt), bounded
and possibly truncated (a long text keeps its start and end), with secrets redacted. The raw bytes stay in the local evidence store.
Without the sidecar it reads the local store directly.

Options:
  <handle>            An evidence handle: ev: and 64 lower-case hex digits, as jevris verify names it
  --selection <id>    The selectionId of the evidence selection that listed the handle, so the
                      read is counted against that selection
  --home <dir>        Jevris home (default: JEVRIS_HOME, else your home directory)
  --workspace <dir>   Workspace (default: the repository containing the current directory)
  --json              Print one JSON result line (the command's contract)

Exit codes: 0 found; 1 not found; 2 usage error or refused input.

Examples:
  jevris evidence get ev:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
  jevris evidence get ev:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 --json`;

type Parsed =
  | { readonly ok: true; readonly positionals: readonly string[]; readonly values: ReadonlyMap<string, string>; readonly lists: ReadonlyMap<string, readonly string[]>; readonly sequence: readonly (readonly [string, string])[]; readonly flags: ReadonlySet<string> }
  | { readonly ok: false; readonly message: string };

export function parseCommandFlags(argv: readonly string[], spec: FlagSpec): Parsed {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const flags = new Set<string>();
  const sequence: (readonly [string, string])[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (spec.boolean.includes(name)) {
      if (eq !== -1) return { ok: false, message: `${name} takes no value.` };
      flags.add(name);
      continue;
    }
    if (spec.value.includes(name) || spec.repeat.includes(name)) {
      const value = eq === -1 ? argv[i + 1] : arg.slice(eq + 1);
      if (value === undefined || value.length === 0) return { ok: false, message: `${name} needs a value.` };
      if (eq === -1) i += 1;
      if (spec.repeat.includes(name)) {
        const list = lists.get(name) ?? [];
        list.push(value);
        lists.set(name, list);
        sequence.push([name, value]);
      } else {
        if (values.has(name)) return { ok: false, message: `${name} was given twice.` };
        values.set(name, value);
      }
      continue;
    }
    return { ok: false, message: `Unknown option ${name.slice(0, 40)}.` };
  }
  return { ok: true, positionals, values, lists, sequence, flags };
}

async function readJsonFile(path: string): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly message: string }> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch {
    return { ok: false, message: `Cannot read ${path}.` };
  }
  if (bytes.byteLength > 1_048_576) return { ok: false, message: `${path} is larger than 1 MiB.` };
  try {
    return { ok: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown };
  } catch {
    return { ok: false, message: `${path} is not valid UTF-8 JSON.` };
  }
}

/** A whole-number flag value as a number; anything else stays text, for the input check to refuse. */
function tokens(text: string | undefined): number | string | undefined {
  return text !== undefined && /^\d{1,12}$/.test(text) ? Number(text) : text;
}

/** The route op's scope and switch facts from --harness, --auth-mode, --remaining-*, --context-tokens, --warm-prefix, --cold-cache and --mid-step. */
function routeFacts(parsed: Extract<Parsed, { ok: true }>): { readonly [key: string]: unknown } {
  const value = (flag: string) => tokens(parsed.values.get(flag));
  const input = value('--remaining-input');
  const output = value('--remaining-output');
  const warm = value('--warm-prefix');
  const cold = parsed.flags.has('--cold-cache');
  const midStep = parsed.flags.has('--mid-step');
  const authMode = parsed.values.get('--auth-mode');
  const harness = parsed.values.get('--harness');
  return {
    // Half of a pair, or a session flag without its prefix, reaches the input check as an
    // incomplete object and is refused there with the field it lacks.
    ...(input !== undefined || output !== undefined ? { remaining: { inputTokens: input, outputTokens: output } } : {}),
    ...(value('--context-tokens') !== undefined ? { contextTokens: value('--context-tokens') } : {}),
    // G20: the harness and sign-in scope the advice; the sign-in also labels a priced switch.
    ...(harness === undefined ? {} : { harness }),
    ...(authMode === undefined ? {} : { authMode }),
    ...(warm !== undefined || cold || midStep
      ? { session: { warmPrefixTokens: warm, ...(cold ? { cacheWarm: false } : {}), ...(midStep ? { atBoundary: false } : {}), ...(authMode === undefined ? {} : { authMode }) } }
      : {}),
  };
}

type RawInput = { readonly ok: true; readonly input: { readonly [key: string]: unknown } } | { readonly ok: false; readonly message: string };

async function rawInputFor(name: PublicCommandName, parsed: Extract<Parsed, { ok: true }>): Promise<RawInput> {
  const pos = parsed.positionals;
  const value = (flag: string) => parsed.values.get(flag);
  const many = (flag: string) => parsed.lists.get(flag) ?? [];
  const noExtra = (max: number): RawInput | null =>
    pos.length > max ? { ok: false, message: `Unexpected argument "${(pos[max] ?? '').slice(0, 40)}".` } : null;
  switch (name) {
    case 'status':
      return noExtra(0) ?? { ok: true, input: {} };
    case 'explain':
      if (pos.length !== 1) return { ok: false, message: 'Give exactly one decision id: jevris explain <decision-id>.' };
      return { ok: true, input: { decisionId: pos[0], ...(parsed.values.has('--slice') ? { sliceId: parsed.values.get('--slice') } : {}) } };
    case 'route':
      return (
        noExtra(0) ?? {
          ok: true,
          input: {
            ...(value('--model') !== undefined ? { currentModel: value('--model') } : {}),
            ...(value('--pin') !== undefined ? { modelPin: value('--pin') } : {}),
            ...(value('--effort-pin') !== undefined ? { effortPin: value('--effort-pin') } : {}),
            ...(value('--task') !== undefined ? { taskId: value('--task') } : {}),
            ...(value('--slice') !== undefined ? { sliceId: value('--slice') } : {}),
            ...routeFacts(parsed),
          },
        }
      );
    case 'plan': {
      const extra = noExtra(0);
      if (extra !== null) return extra;
      const graph = value('--graph');
      if (graph === undefined) return { ok: false, message: 'Give the task graph file: jevris plan --graph <tasks.json>.' };
      const read = await readJsonFile(graph);
      if (!read.ok) return read;
      const tasks = Array.isArray(read.value) ? read.value : (read.value as { tasks?: unknown } | null)?.tasks;
      return { ok: true, input: { tasks } };
    }
    case 'checkpoint':
      return (
        noExtra(0) ?? {
          ok: true,
          input: {
            ...(value('--objective') !== undefined ? { objective: value('--objective') } : {}),
            constraints: many('--constraint'),
            ...(value('--task') !== undefined ? { taskId: value('--task') } : {}),
          },
        }
      );
    case 'recover': {
      const extra = noExtra(0);
      if (extra !== null) return extra;
      // Order matters for oscillation, so failures keep the command-line order.
      const fingerprints: string[] = [];
      const environment: boolean[] = [];
      for (const [flag, print] of parsed.sequence) {
        if (flag !== '--failure' && flag !== '--env-failure') continue;
        fingerprints.push(print);
        environment.push(flag === '--env-failure');
      }
      return {
        ok: true,
        input: {
          fingerprints,
          environment,
          rejectedApproaches: many('--rejected'),
          ...(value('--task') !== undefined ? { taskId: value('--task') } : {}),
        },
      };
    }
    case 'verify':
      return noExtra(0) ?? { ok: true, input: { checkIds: many('--check'), ...(value('--task') !== undefined ? { taskId: value('--task') } : {}) } };
    case 'configure': {
      if (pos.length === 0 || (pos.length === 1 && pos[0] === 'show')) {
        if (parsed.flags.has('--dry-run')) return { ok: false, message: '--dry-run applies to configure set.' };
        return parsed.flags.has('--yes') ? { ok: false, message: '--yes applies to configure set.' } : { ok: true, input: {} };
      }
      if (pos[0] === 'set' && pos.length === 3) {
        // SR-19: --yes never confirms a raise; only a person at a terminal does (confirmConfigureSet).
        return { ok: true, input: { key: pos[1], value: pos[2], dryRun: parsed.flags.has('--dry-run'), confirmed: false } };
      }
      return { ok: false, message: 'Use jevris configure show, or jevris configure set <key> <value> [--dry-run].' };
    }
  }
}

export interface PublicCommandOptions {
  readonly ports?: SurfacePorts;
  readonly env?: { readonly [key: string]: string | undefined };
  readonly cwd?: string;
  readonly nowMs?: () => number;
  /** Store driver probe for the status diagnostic (BLD-13). */
  readonly probeSqlite?: () => NativeProbe;
  /** verify administration: the terminal confirmation (tests inject it; null means none). */
  readonly confirm?: ((question: string) => Promise<boolean>) | null;
  /** verify administration and owned mode: whether stdin and stdout are a terminal (tests inject it). */
  readonly interactive?: () => boolean;
}

/** The verify subcommands handled by verify-admin.ts (kept here so plain verify stays light). */
const VERIFY_ADMIN = new Set(['profile', 'approve', 'revoke', 'issuer', 'waive', 'import-ci', 'required']);

function emitLine(write: Write, text: string): void {
  write(text.endsWith('\n') ? text : `${text}\n`);
}

/**
 * SR-19 (owner decision 2e13b6fe): a `configure set` that raises mode, routing.managedWorkers or
 * routing.mainSession above its effective value (D's raisesAuthority) needs a person at an
 * interactive terminal who answers y (B's personAtTerminal). --yes, --json, a pipe and a test run
 * are refused with CHANNEL_REFUSED before anything is asked. Lowering, the same value and a dry
 * run are not asked.
 */
async function confirmConfigureSet(
  input: unknown,
  flags: { readonly yes: boolean; readonly json: boolean; readonly home: string; readonly env: { readonly [key: string]: string | undefined } },
  write: Write,
  options: PublicCommandOptions,
): Promise<'confirmed' | 'declined' | 'refused' | 'not-asked'> {
  const set = input as { readonly key?: unknown; readonly value?: unknown; readonly dryRun?: unknown };
  if (typeof set.key !== 'string' || typeof set.value !== 'string' || set.dryRun === true) return 'not-asked';
  const { home, env } = flags;
  if (!raisesAuthority({ home, env }, set.key, set.value)) return 'not-asked';
  const { personAtTerminal } = await import('./verify-admin.js');
  let refusal = '';
  const channel = { yes: flags.yes, json: flags.json, env, interactive: options.interactive, confirm: options.confirm };
  const what = raiseWhat(set.key, set.value);
  const ok = await personAtTerminal(channel, raisePrompt(set.key, set.value), (text) => (refusal += text), what);
  if (refusal.length > 0) write(flags.json ? `${JSON.stringify({ error: { code: 'CHANNEL_REFUSED', message: refusal.trim() } })}\n` : refusal);
  return ok ? 'confirmed' : refusal.length > 0 ? 'refused' : 'declined';
}

/** Runs one public command from its argv (without the command name). Returns the exit code. */
export async function runPublicCommand(name: PublicCommandName, argv: readonly string[], write: Write, options: PublicCommandOptions = {}): Promise<number> {
  if ((argv.includes('--help') || argv.includes('-h')) && !(name === 'route' && (argv[0] === 'learning' || argv[0] === 'limits'))) {
    emitLine(write, PUBLIC_HELP[name]);
    return COMMAND_EXIT_CODES.ok;
  }
  // Route learning (C16, C52): CLI-only; changes need a person.
  if (name === 'route' && argv[0] === 'learning') {
    const { runRouteLearningCommand } = await import('./route-learning-command.js');
    return runRouteLearningCommand(argv.slice(1), write, {
      ...(options.ports !== undefined ? { ports: options.ports } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    });
  }
  // Access limits (R78): the list reads the machine record; a clear needs a person at a terminal.
  if (name === 'route' && argv[0] === 'limits') {
    const { runRouteLimitsCommand } = await import('./access-limits-command.js');
    return runRouteLimitsCommand(argv.slice(1), write, {
      ...(options.ports !== undefined ? { ports: options.ports } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
      ...(options.confirm !== undefined ? { confirm: options.confirm } : {}),
    });
  }
  // Session-to-task link (owner decision 29423b6, B's session.link): CLI-only, a link needs a terminal.
  if (name === 'route' && (argv.includes('--link') || argv.includes('--unlink'))) {
    const { runRouteLink } = await import('./route-link.js');
    return runRouteLink(argv, write, {
      ...(options.ports !== undefined ? { ports: options.ports } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
    });
  }
  // Verification administration (CLI-only): approvals, waivers, CI issuers and imports.
  if (name === 'verify' && VERIFY_ADMIN.has(argv[0] ?? '')) {
    const { runVerifyAdmin } = await import('./verify-admin.js');
    return runVerifyAdmin(argv, write, {
      ...(options.ports !== undefined ? { ports: options.ports } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
      ...(options.confirm !== undefined ? { confirm: options.confirm } : {}),
      ...(options.interactive !== undefined ? { interactive: options.interactive } : {}),
    });
  }
  // Plan submission (CLI-only): owned work under a root budget, through D's plan.submit op.
  if (name === 'plan' && argv.includes('--submit')) {
    const { runPlanSubmit } = await import('./plan-submit.js');
    return runPlanSubmit(argv, write, {
      ...(options.ports !== undefined ? { ports: options.ports } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
      ...(options.confirm !== undefined ? { confirm: options.confirm } : {}),
      ...(options.interactive !== undefined ? { interactive: options.interactive } : {}),
    });
  }
  // Owner decision 2026-09-29: a workspace's own cap on Jev decision calls (CLI-only; a raise needs a person).
  if (name === 'configure' && argv[0] === 'workspace-budget') {
    const { runWorkspaceBudget } = await import('./workspace-budget-command.js');
    return runWorkspaceBudget(argv, write, {
      ...(options.ports !== undefined ? { ports: options.ports } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
      ...(options.confirm !== undefined ? { confirm: options.confirm } : {}),
      ...(options.interactive !== undefined ? { interactive: options.interactive } : {}),
    });
  }
  if (name === 'configure' && argv[0] === 'owned-mode') {
    const { runOwnedMode } = await import('./verify-admin.js');
    return runOwnedMode(argv, write, {
      ...(options.ports !== undefined ? { ports: options.ports } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
      ...(options.confirm !== undefined ? { confirm: options.confirm } : {}),
      ...(options.interactive !== undefined ? { interactive: options.interactive } : {}),
    });
  }
  const parsed = parseCommandFlags(argv, FLAGS[name]);
  const json = parsed.ok && parsed.flags.has('--json');
  const usage = (message: string): number => {
    if (json) emitLine(write, JSON.stringify({ error: { code: 'USAGE', message } }));
    else emitLine(write, `${message}\nRun jevris ${name} --help for usage.`);
    return COMMAND_EXIT_CODES.usage;
  };
  if (!parsed.ok) return usage(parsed.message);
  const raw = await rawInputFor(name, parsed);
  if (!raw.ok) return usage(raw.message);
  let input = raw.input;
  const ctx = createSurfaceContext({
    home: parsed.values.get('--home'),
    workspace: parsed.values.get('--workspace'),
    scope: 'cli',
    ports: options.ports ?? (await defaultPorts()),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
  });
  if (name === 'configure') {
    const asked = await confirmConfigureSet(raw.input, { yes: parsed.flags.has('--yes'), json, home: ctx.home, env: ctx.env }, write, options);
    // personAtTerminal already wrote the CHANNEL_REFUSED line.
    if (asked === 'refused') return COMMAND_EXIT_CODES.usage;
    if (asked === 'declined') {
      emitLine(write, json ? JSON.stringify({ error: { code: 'USAGE', message: 'Nothing was changed.' } }) : 'Nothing was changed.');
      return COMMAND_EXIT_CODES.usage;
    }
    if (asked === 'confirmed') input = { ...input, confirmed: true };
  }
  const outcome = await runOperation(ctx, name, input);
  if (!outcome.ok) {
    // exit 1 (the sidecar took the request and did not answer: not a refusal) or a refusal with a reason
    // (configure's CHANNEL_REFUSED or CONFIG_INVALID, MODE_OFF): the code, then the message.
    const report = refusalReport(outcome, json);
    if (report !== null) {
      emitLine(write, report.line);
      return report.exitCode;
    }
  }
  if (!outcome.ok) return usage(outcome.message);
  let text = json ? `${JSON.stringify(outcome.result)}\n` : renderHuman(outcome.result);
  if (!json && name === 'status' && options.probeSqlite !== undefined) {
    const probe = options.probeSqlite();
    if (!probe.ok) text += `${probe.diagnostic}\n`;
  }
  if (!json && (name === 'route' || name === 'explain')) {
    // The data line for the model the answer names, per sign-in, from the registry routing reads (7be3c43).
    const registry = await Promise.resolve(ctx.ports.engine.loadRegistry?.({ home: ctx.home }) ?? loadModelRegistry({ home: ctx.home })).catch(() => null);
    let terms: string | null = null;
    try {
      terms = resultDataTermsLine(outcome.result, registry ?? null);
    } catch {
      terms = null;
    }
    if (terms !== null) text += `${terms}\n`;
  }
  if (!json && name === 'status') {
    // A test provider override (loopback mock Jev) is always named, so it is never mistaken for production.
    const override = providerOverrideDiagnostic(options.env ?? process.env);
    if (override !== null) text += `${override}\n`;
  }
  write(text);
  return outcome.exitCode;
}

/** `jevris evidence get <handle>`: the evidence.get operation from the CLI. */
export async function runEvidenceCommand(argv: readonly string[], write: Write, options: PublicCommandOptions = {}): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    emitLine(write, EVIDENCE_HELP);
    return COMMAND_EXIT_CODES.ok;
  }
  const parsed = parseCommandFlags(argv, { ...COMMON, value: [...COMMON.value, '--selection'] });
  const json = parsed.ok && parsed.flags.has('--json');
  const usage = (message: string): number => {
    if (json) emitLine(write, JSON.stringify({ error: { code: 'USAGE', message } }));
    else emitLine(write, `${message}\nRun jevris help evidence for usage.`);
    return COMMAND_EXIT_CODES.usage;
  };
  if (!parsed.ok) return usage(parsed.message);
  if (parsed.positionals.length !== 2 || parsed.positionals[0] !== 'get') return usage('Use jevris evidence get <handle>.');
  const ctx = createSurfaceContext({
    home: parsed.values.get('--home'),
    workspace: parsed.values.get('--workspace'),
    scope: 'cli',
    ports: options.ports ?? (await defaultPorts()),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
  });
  const selectionId = parsed.values.get('--selection');
  const outcome = await runOperation(ctx, 'evidence.get', { handle: parsed.positionals[1], ...(selectionId !== undefined ? { selectionId } : {}) });
  if (!outcome.ok) {
    const report = refusalReport(outcome, json);
    if (report === null) return usage(outcome.message);
    emitLine(write, report.line);
    return report.exitCode;
  }
  write(json ? `${JSON.stringify(outcome.result)}\n` : renderHuman(outcome.result));
  return outcome.exitCode;
}

const SURFACE_INPUT_CAP = 1_048_576;

/**
 * The MCP server's entry: `jevris __surface <operation>` with the arguments as JSON on stdin.
 * Prints exactly one JSON line: the result contract, or `{"error":{"code","message"}}`.
 */
export async function runSurfaceCall(
  argv: readonly string[],
  write: Write,
  readStdin: () => Promise<Uint8Array>,
  options: PublicCommandOptions = {},
): Promise<number> {
  const fail = (code: string, message: string): number => {
    write(`${JSON.stringify({ error: { code, message } })}\n`);
    return COMMAND_EXIT_CODES.usage;
  };
  const op = argv[0];
  if (argv.length !== 1 || !isSurfaceOperation(op)) return fail('UNKNOWN_OPERATION', 'Unknown Jevris operation.');
  const bytes = await readStdin();
  if (bytes.byteLength > SURFACE_INPUT_CAP) return fail('OVERSIZE', 'The arguments are larger than 1 MiB.');
  let args: unknown = {};
  if (bytes.byteLength > 0) {
    try {
      args = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    } catch {
      return fail('INVALID_JSON', 'The arguments are not valid JSON.');
    }
  }
  const env = options.env ?? process.env;
  const ctx = createSurfaceContext({
    scope: 'mcp',
    env,
    ports: options.ports ?? (await defaultPorts()),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
  });
  const outcome = await runOperation(ctx, op, args);
  if (!outcome.ok && outcome.exitCode === COMMAND_EXIT_CODES.negative) {
    write(`${JSON.stringify({ error: { code: outcome.reasonCode, message: outcome.message } })}\n`);
    return outcome.exitCode;
  }
  // MODE_OFF and KILL_SWITCH keep their codes, so an MCP client can tell "Jevris is off" or "the kill switch is on"
  // from a refused input.
  if (!outcome.ok) return fail(outcome.reasonCode === 'MODE_OFF' || outcome.reasonCode === 'KILL_SWITCH' ? outcome.reasonCode : 'REFUSED', outcome.message);
  write(`${JSON.stringify(outcome.result)}\n`);
  return outcome.exitCode;
}
